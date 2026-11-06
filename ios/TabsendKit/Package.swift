// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "TabsendKit",
    // English is the source language. A String Catalog in Resources/ holds every
    // sentence the package produces (docs/L10N.md); adding a language is a
    // translation of that catalog, no code change.
    defaultLocalization: "en",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "TabsendKit", targets: ["TabsendKit"])
    ],
    targets: [
        .target(name: "TabsendKit", resources: [.process("Resources")]),
        .testTarget(
            name: "TabsendKitTests",
            dependencies: ["TabsendKit"],
            resources: [
                .copy("Resources/interop-vector.json"),
                .copy("Resources/group-history-vector.json"),
                .copy("Resources/english-copy-golden.json"),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
