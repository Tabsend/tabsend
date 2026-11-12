import Foundation

/// What the "More" menu on a device row offers. The same rule as the browsers' device
/// list (extension/src/pages/device-list.ts, `rowActions`): every device can be renamed,
/// and every device except this phone can be removed. This phone leaves through Unpair,
/// which also wipes what it holds, so a Remove here would be a trap.
public enum DeviceRowAction: Equatable, Sendable {
    case rename
    case remove
}

public enum DeviceRowActions {
    public static func actions(isThisPhone: Bool) -> [DeviceRowAction] {
        isThisPhone ? [.rename] : [.rename, .remove]
    }

    /// Whether a typed name is worth sending: the relay needs something to show.
    public static func cleanedName(_ typed: String) -> String? {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
