import Foundation
import AVFoundation

enum ProbeCommand {
    static func run(mode: CaptureMode) {
        let needsMic = (mode == .mic || mode == .both)
        let needsScreen = (mode == .system || mode == .both)

        if needsMic {
            let status = AVCaptureDevice.authorizationStatus(for: .audio)
            switch status {
            case .authorized: break
            case .notDetermined:
                LogHelper.info("mic permission not yet determined")
                exit(ExitCode.micPermissionDenied.rawValue)
            case .denied, .restricted:
                LogHelper.error("mic permission denied")
                exit(ExitCode.micPermissionDenied.rawValue)
            @unknown default:
                LogHelper.error("mic permission status unknown")
                exit(ExitCode.micPermissionDenied.rawValue)
            }
        }

        if needsScreen {
            // ScreenCaptureKit doesn't expose a permission-status API pre-capture;
            // the best we can do is attempt shareable-content query which triggers
            // the prompt. For probe we just return ok here; actual capture will
            // surface the denial if permission is missing.
            LogHelper.info("screen recording permission check deferred to capture start")
        }

        exit(ExitCode.ok.rawValue)
    }
}
