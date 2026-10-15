// swift-tools-version: 5.9
// Built into an iOS app by xtool (https://xtool.sh): `xtool dev` in this directory.
import PackageDescription

let package = Package(
    name: "Calliope",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "Calliope", targets: ["Calliope"])
    ],
    targets: [
        .target(name: "Calliope")
    ]
)
