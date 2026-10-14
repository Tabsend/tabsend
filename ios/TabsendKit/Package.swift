// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "TabsendKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "TabsendKit", targets: ["TabsendKit"])
    ],
    targets: [
        .target(name: "TabsendKit"),
        .testTarget(
            name: "TabsendKitTests",
            dependencies: ["TabsendKit"],
            resources: [
                .copy("Resources/interop-vector.json"),
                .copy("Resources/group-history-vector.json"),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
