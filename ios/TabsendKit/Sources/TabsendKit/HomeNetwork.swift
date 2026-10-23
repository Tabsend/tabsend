import Foundation

/// Is this relay on a home-network address (PLANS.md P-15 item 4)?
///
/// "Can't reach your relay at http://192.168.1.20:8786" was true, but read as a
/// refresh bug: the device was simply away from home, where that address means
/// nothing. When the address can only work on the network it lives on, the
/// relay-down line adds `hint`, which says why and what to do.
///
/// Home network: IPv4 10/8, 172.16/12, 192.168/16, link-local 169.254/16; IPv6
/// unique-local fc00::/7 and link-local fe80::/10; names under .local, .lan,
/// .home.arpa and .internal.
///
/// Never: localhost and loopback (the relay is on this same device, so being away
/// is not the reason); 100.64/10 and Tailscale's IPv6 fd7a:115c:a1e0::/48 (a
/// Tailscale address works from anywhere while Tailscale is on, so "only works on
/// your home network" would be false); a single-label name, which may be a
/// Tailscale MagicDNS name; every public address and name, the hosted relay
/// included.
///
/// A port of `shared/src/homenetwork.ts`, mirrored by `HomeNetwork.kt` on
/// Android. All three run `shared/vectors/home-network.json`. The host is read by
/// hand rather than through `URL`, so all three agree on odd input.
public enum HomeNetwork {

    /// The line added after the relay-down notice when `isHomeNetworkRelay` is true.
    public static let hint = "This address only works on your home network. Away from home or on "
        + "mobile data? Connect to your home Wi-Fi or turn on your VPN."

    private static let homeSuffixes = [".local", ".lan", ".home.arpa", ".internal"]

    /// True when `relayUrl` points at an address that only works on its own local network.
    public static func isHomeNetworkRelay(_ relayUrl: String) -> Bool {
        guard let host = hostOf(relayUrl.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return false
        }
        if let octets = ipv4Octets(host) { return isHomeIpv4(octets) }
        if let head = ipv6Head(host) { return isHomeIpv6(head) }
        if host.contains(":") { return false }
        return homeSuffixes.contains { host.hasSuffix($0) && host.count > $0.count }
    }

    /// Host of an http(s) URL, lowercased, IPv6 without brackets.
    private static func hostOf(_ url: String) -> String? {
        guard let scheme = url.range(of: "://") else { return nil }
        var authority = String(url[scheme.upperBound...].prefix { $0 != "/" && $0 != "?" && $0 != "#" })
        if let at = authority.lastIndex(of: "@") {
            authority = String(authority[authority.index(after: at)...])
        }
        var host: String
        if authority.hasPrefix("[") {
            guard let end = authority.firstIndex(of: "]") else { return nil }
            host = String(authority[authority.index(after: authority.startIndex)..<end])
        } else {
            host = String(authority.prefix { $0 != ":" })
        }
        host = host.lowercased()
        if host.hasSuffix(".") { host.removeLast() }
        return host.isEmpty ? nil : host
    }

    private static func isAsciiDigit(_ c: Character) -> Bool {
        c >= "0" && c <= "9"
    }

    private static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        for part in parts {
            guard (1...3).contains(part.count), part.allSatisfy(isAsciiDigit),
                  let value = Int(part), value <= 255 else { return nil }
            octets.append(value)
        }
        return octets
    }

    private static func isHomeIpv4(_ o: [Int]) -> Bool {
        let a = o[0], b = o[1]
        return a == 10
            || (a == 172 && (16...31).contains(b))
            || (a == 192 && b == 168)
            || (a == 169 && b == 254)
    }

    private static func isHexDigit(_ c: Character) -> Bool {
        isAsciiDigit(c) || (c >= "a" && c <= "f")
    }

    /// The first three 16-bit groups of an IPv6 address, or nil if it is not one.
    private static func ipv6Head(_ host: String) -> [Int]? {
        let bare = String(host.prefix { $0 != "%" })
        guard bare.contains(":"),
              bare.allSatisfy({ isHexDigit($0) || $0 == ":" || $0 == "." }) else { return nil }
        let halves = bare.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        let left = halves[0].split(separator: ":").map(String.init)
        // With "::", the group straight after the left half is always zero.
        let groups = halves.count == 2 ? left + ["0", "0", "0"] : left
        let head = Array(groups.prefix(3))
        guard head.count == 3 else { return nil }
        var values: [Int] = []
        for group in head {
            guard (1...4).contains(group.count), group.allSatisfy(isHexDigit),
                  let value = Int(group, radix: 16) else { return nil }
            values.append(value)
        }
        return values
    }

    private static func isHomeIpv6(_ head: [Int]) -> Bool {
        let g0 = head[0], g1 = head[1], g2 = head[2]
        // Tailscale's own range, inside fc00::/7 but reachable from anywhere.
        if g0 == 0xfd7a && g1 == 0x115c && g2 == 0xa1e0 { return false }
        if g0 & 0xfe00 == 0xfc00 { return true } // unique-local fc00::/7
        if g0 & 0xffc0 == 0xfe80 { return true } // link-local fe80::/10
        return false
    }
}
