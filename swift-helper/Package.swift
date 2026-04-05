// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AudioCaptureHelper",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "audio-capture-helper", targets: ["AudioCaptureHelper"]),
    ],
    targets: [
        .executableTarget(
            name: "AudioCaptureHelper",
            path: "Sources/AudioCaptureHelper"
        ),
        .testTarget(
            name: "AudioCaptureHelperTests",
            dependencies: ["AudioCaptureHelper"],
            path: "Tests/AudioCaptureHelperTests"
        ),
    ]
)
