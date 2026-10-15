import UIKit
import WebKit
import Combine
import os.log

/// Owns both web views and carries speaker.js messages between them. In the
/// browser the speaker and audience pages talk with postMessage; here each page
/// gets a `window.svgdeckNative` object and this class is the wire between them.
final class Presenter: NSObject, ObservableObject {
    static let shared = Presenter()

    @Published var serverURL: URL? {
        didSet { UserDefaults.standard.set(serverURL?.absoluteString, forKey: "serverURL") }
    }
    @Published private(set) var externalConnected = false
    @Published private(set) var canGoBack = false
    /// What UIKit sees: screens and scenes. Shown while no display is attached.
    @Published private(set) var diagnostics = ""

    let speakerView: WKWebView
    private(set) var audienceView: WKWebView?
    private var externalWindows: [ObjectIdentifier: UIWindow] = [:]
    /// Windows the page opened with about:blank; their real address arrives with the first navigation.
    private var popups: [WKWebView] = []
    private var session = ""
    private var observations: [NSKeyValueObservation] = []
    private var poll: Timer?

    private override init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL").flatMap { URL(string: $0) }
        speakerView = WKWebView(frame: .zero, configuration: Presenter.configuration(role: "speaker"))
        super.init()
        speakerView.navigationDelegate = self
        speakerView.uiDelegate = self
        speakerView.allowsBackForwardNavigationGestures = true
        speakerView.backgroundColor = .systemBackground
        speakerView.configuration.userContentController.add(self, name: "svgdeck")
        observations.append(speakerView.observe(\.canGoBack, options: [.new]) { [weak self] view, _ in
            self?.canGoBack = view.canGoBack
        })
        // Belt and braces: scenes announce themselves even if the scene delegate is not used.
        let center = NotificationCenter.default
        center.addObserver(forName: UIScene.willConnectNotification, object: nil, queue: .main) { [weak self] note in
            guard let scene = note.object as? UIWindowScene, scene.session.role == .windowExternalDisplayNonInteractive else { return }
            _ = self?.attach(scene: scene)
        }
        center.addObserver(forName: UIScene.didDisconnectNotification, object: nil, queue: .main) { [weak self] note in
            guard let scene = note.object as? UIWindowScene else { return }
            self?.detach(scene: scene)
        }
        // And a scan: a scene for another screen that reached us by neither route is attached here.
        poll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.scan() }
        goHome()
    }

    private func scan() {
        var roles: [String] = []
        for scene in UIApplication.shared.connectedScenes {
            let role = scene.session.role.rawValue.replacingOccurrences(of: "UIWindowSceneSessionRole", with: "")
            roles.append(role)
            guard let windowScene = scene as? UIWindowScene else { continue }
            let external = scene.session.role == .windowExternalDisplayNonInteractive || windowScene.screen !== UIScreen.main
            if external, externalWindows[ObjectIdentifier(windowScene)] == nil { attach(scene: windowScene) }
        }
        diagnostics = "screens \(UIScreen.screens.count) · scenes: \(roles.joined(separator: ", "))"
        if diagnostics != lastLogged { lastLogged = diagnostics; os_log("[calliope] %{public}@", diagnostics) }
    }
    private var lastLogged = ""

    private static func configuration(role: String) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        // Service workers, and with them the offline copy the deck list keeps, only
        // run in a web view bound to the domains in Info.plist (WKAppBoundDomains).
        config.limitsNavigationsToAppBoundDomains = true
        let bridge = """
        (function () {
          if (window.svgdeckNative) return;
          window.svgdeckNative = {
            role: '\(role)', closed: false,
            postMessage: function (m) { window.webkit.messageHandlers.svgdeck.postMessage(m); }
          };
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        return config
    }

    // MARK: Navigation

    func goHome() {
        if let url = serverURL {
            speakerView.load(URLRequest(url: url))
        } else {
            speakerView.loadHTMLString(Presenter.welcome, baseURL: nil)
        }
    }

    /// A link the page wants in a new window. A presenter page goes to the screens; anything else loads here.
    func open(_ url: URL) {
        guard let pair = pair(for: url) else { speakerView.load(URLRequest(url: url)); return }
        session = pair.session
        if externalConnected, let audienceView {
            audienceView.load(URLRequest(url: pair.audience))
            speakerView.load(URLRequest(url: pair.speaker))
        } else {
            speakerView.load(URLRequest(url: url))
        }
    }

    /// For a presenter page `/d/<deck>/…`: the speaker and audience addresses sharing one session.
    private func pair(for url: URL) -> (speaker: URL, audience: URL, session: String)? {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return nil }
        let path = parts.path.split(separator: "/", omittingEmptySubsequences: false)
        guard path.count == 4, path[1] == "d", !path[2].isEmpty, path[3].isEmpty else { return nil }
        var items = (parts.queryItems ?? []).filter { $0.name != "speaker" && $0.name != "session" }
        let session = parts.queryItems?.first { $0.name == "session" }?.value ?? Presenter.randomSession()
        items.append(URLQueryItem(name: "session", value: session))
        parts.queryItems = items
        guard let audience = parts.url else { return nil }
        parts.queryItems = [URLQueryItem(name: "speaker", value: "1")] + items
        guard let speaker = parts.url else { return nil }
        return (speaker, audience, session)
    }

    private static func randomSession() -> String {
        (0..<4).map { _ in String(UInt32.random(in: .min ... .max), radix: 16) }.joined()
    }

    // MARK: External display

    /// Puts the audience view on a newly connected screen. Returns the window so the scene delegate can keep it.
    @discardableResult
    func attach(scene: UIWindowScene) -> UIWindow? {
        let key = ObjectIdentifier(scene)
        if let window = externalWindows[key] { return window }
        let view = audienceView ?? makeAudienceView()
        // iPadOS shrinks external output by default, for TVs that cut off the edges.
        // Projectors and monitors don't, and the deck is letterboxed by the page itself.
        scene.screen.overscanCompensation = .none
        let window = UIWindow(windowScene: scene)
        window.rootViewController = AudienceViewController(webView: view)
        window.isHidden = false
        externalWindows[key] = window
        externalConnected = true
        tell(speakerView, ["svgdeck": session, "type": "display", "value": true])
        // Already in the speaker view? Its audience half belongs on the new screen.
        if let url = speakerView.url, let pair = pair(for: url) {
            session = pair.session
            view.load(URLRequest(url: pair.audience))
        }
        return window
    }

    func detach(scene: UIWindowScene) {
        externalWindows[ObjectIdentifier(scene)] = nil
        guard externalWindows.isEmpty else { return }
        externalConnected = false
        audienceView?.loadHTMLString(Presenter.blank, baseURL: nil)
        tell(speakerView, ["svgdeck": session, "type": "display", "value": false])
    }

    private func makeAudienceView() -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: Presenter.configuration(role: "audience"))
        view.configuration.userContentController.add(self, name: "svgdeck")
        view.navigationDelegate = self
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.loadHTMLString(Presenter.blank, baseURL: nil)
        audienceView = view
        return view
    }

    // MARK: The wire between the two pages

    private func tell(_ view: WKWebView, _ body: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body),
              let json = String(data: data, encoding: .utf8) else { return }
        view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('svgdeck:native', {detail: \(json)}))") { _, _ in }
    }

    private static let welcome = """
    <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
    <body style="font: 17px -apple-system, system-ui; color: #333; background: #fafafa; margin: 0; display: grid; place-items: center; height: 100vh">
    <p style="max-width: 28em; padding: 0 16px">Set the Calliope server address under the gear icon, then open a deck and tap Present.</p>
    """

    private static let blank = """
    <!doctype html><body style="background: #000; margin: 0">
    """

    private func showError(_ error: Error, in view: WKWebView) {
        guard view === speakerView else { return }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        let url = (nsError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) ?? serverURL?.absoluteString ?? ""
        let escape = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let page = """
        <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <body style="font: 17px -apple-system, system-ui; color: #333; background: #fafafa; margin: 0; display: grid; place-items: center; height: 100vh">
        <div style="max-width: 32em; padding: 0 16px"><p><b>Could not load</b><br><code>\(escape(url))</code></p>
        <p>\(escape(nsError.localizedDescription))<br><small>\(escape(nsError.domain)) \(nsError.code)</small></p>
        <p>Check the server address under the gear icon and that Tailscale is connected, then reload.</p></div>
        """
        view.loadHTMLString(page, baseURL: nil)
    }
}

extension Presenter: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let fromSpeaker = message.webView === speakerView
        if fromSpeaker, let id = body["svgdeck"] as? String { session = id }
        switch type {
        case "display":
            // The speaker page asks whether a screen is attached.
            tell(speakerView, ["svgdeck": session, "type": "display", "value": externalConnected])
        case "open":
            // The speaker page asks for its audience view on the screen.
            if externalConnected, let audienceView, let raw = body["value"] as? String,
               let url = URL(string: raw, relativeTo: speakerView.url) {
                audienceView.load(URLRequest(url: url))
            }
            tell(speakerView, ["svgdeck": session, "type": "display", "value": externalConnected])
        default:
            if fromSpeaker { if let audienceView { tell(audienceView, body) } } else { tell(speakerView, body) }
        }
    }
}

extension Presenter: WKUIDelegate, WKNavigationDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, !url.absoluteString.isEmpty, url.absoluteString != "about:blank" {
            open(url)
            return nil
        }
        // about:blank now, the real address later: a throwaway view hears it.
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = self
        popups.append(popup)
        return popup
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if popups.contains(webView), let url = navigationAction.request.url, url.absoluteString != "about:blank" {
            popups.removeAll { $0 === webView }
            open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webViewDidClose(_ webView: WKWebView) {
        popups.removeAll { $0 === webView }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        os_log("[calliope] %{public}@ loaded %{public}@", webView === speakerView ? "speaker" : "audience", webView.url?.absoluteString ?? "-")
    }

    /// WebKit's content process was killed (memory pressure, mostly); the page comes back blank otherwise.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        os_log("[calliope] content process died; reloading")
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(error, in: webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError(error, in: webView)
    }
}

/// Full-bleed audience web view on a black background.
final class AudienceViewController: UIViewController {
    private let webView: WKWebView

    init(webView: WKWebView) {
        self.webView = webView
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }
}
