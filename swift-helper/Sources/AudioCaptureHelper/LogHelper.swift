import Foundation

/// JSON-line logger that writes to stderr. stdout is reserved for raw PCM.
enum LogHelper {
    static func log(level: String, msg: String, meta: [String: String] = [:]) {
        var payload: [String: String] = ["level": level, "msg": msg]
        for (k, v) in meta { payload[k] = v }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
            return
        }
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    }

    static func info(_ msg: String, meta: [String: String] = [:]) {
        log(level: "info", msg: msg, meta: meta)
    }

    static func warn(_ msg: String, meta: [String: String] = [:]) {
        log(level: "warn", msg: msg, meta: meta)
    }

    static func error(_ msg: String, meta: [String: String] = [:]) {
        log(level: "error", msg: msg, meta: meta)
    }
}
