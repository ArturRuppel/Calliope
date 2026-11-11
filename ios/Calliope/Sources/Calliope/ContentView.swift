import SwiftUI
import WebKit

struct ContentView: View {
    @EnvironmentObject private var presenter: Presenter
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 20) {
                Button { presenter.speakerView.goBack() } label: { Image(systemName: "chevron.left") }
                    .disabled(!presenter.canGoBack)
                    .accessibilityLabel("Back")
                Button { presenter.goHome() } label: { Image(systemName: "house") }
                    .accessibilityLabel("Decks")
                Spacer()
                Label(presenter.externalConnected ? "External display connected" : "No external display · \(presenter.diagnostics)",
                      systemImage: presenter.externalConnected ? "tv.fill" : "tv")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Button { presenter.speakerView.reload() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Reload")
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.bar)
            WebView(webView: presenter.speakerView)
                .ignoresSafeArea(edges: .bottom)
        }
        .sheet(isPresented: $showSettings) { SettingsView().environmentObject(presenter) }
        .onAppear { if presenter.serverURL == nil { showSettings = true } }
    }
}

/// Hosts the one speaker web view. A second Calliope window on the iPad (multiple
/// scenes are on, for the external display) cannot have it too, and says so.
struct WebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> UIView {
        let host = UIView()
        host.backgroundColor = .systemBackground
        let view: UIView
        if webView.window == nil {
            view = webView
        } else {
            let label = UILabel()
            label.text = "Calliope is open in another window."
            label.textAlignment = .center
            label.textColor = .secondaryLabel
            view = label
        }
        view.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(view)
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: host.topAnchor),
            view.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            view.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: host.trailingAnchor),
        ])
        return host
    }

    func updateUIView(_ host: UIView, context: Context) {}
}

struct SettingsView: View {
    @EnvironmentObject private var presenter: Presenter
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://myhost.example.ts.net:8490/", text: $text)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Calliope server")
                } footer: {
                    Text("The address this iPad opens Calliope at, on the host the app was configured for. Tailscale has to be connected; a deck the list has copied presents without it.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done", action: save) }
            }
            .onAppear { text = presenter.serverURL?.absoluteString ?? "" }
        }
    }

    private func save() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed), url.scheme != nil, url.absoluteString != presenter.serverURL?.absoluteString {
            presenter.serverURL = url
            presenter.goHome()
        }
        dismiss()
    }
}
