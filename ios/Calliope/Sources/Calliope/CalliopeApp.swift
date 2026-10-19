import SwiftUI
import UIKit

/// A thin shell around the Calliope web app. The iPad shows Calliope itself; when
/// a second screen is attached (cable or AirPlay) and a deck is presented, the
/// audience view goes to that screen and a second copy of it stays on the iPad,
/// where it is touched (zoom, marks, pointer) and where a screen share picks it
/// up: iPadOS only ever broadcasts the iPad's own screen. Speaker view is a button
/// on that copy.
@main
struct CalliopeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var presenter = Presenter.shared

    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(presenter)
        }
    }
}

/// Scenes get their delegate here: the external display gets `ExternalSceneDelegate`,
/// the iPad screen `MainSceneDelegate`. SwiftUI still hosts the `WindowGroup` in the
/// main scene, so that delegate must not make a window of its own: a second window
/// would cover SwiftUI's, and the web view can only be in one of them.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = session.role == .windowExternalDisplayNonInteractive
            ? ExternalSceneDelegate.self : MainSceneDelegate.self
        return config
    }
}

/// The iPad screen. SwiftUI puts ContentView in this scene; nothing to do here.
final class MainSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
}

/// The external display: one window, the audience web view, nothing else.
final class ExternalSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        window = Presenter.shared.attach(scene: scene)
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        guard let scene = scene as? UIWindowScene else { return }
        Presenter.shared.detach(scene: scene)
        window = nil
    }
}
