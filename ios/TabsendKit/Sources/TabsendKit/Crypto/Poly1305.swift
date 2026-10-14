import Foundation

/// Poly1305 one-time authenticator (RFC 8439), 26-bit limb implementation
/// ported from poly1305-donna. Key clamping happens here, matching libsodium.
enum Poly1305 {
    static let tagBytes = 16

    static func mac(message: [UInt8], key: [UInt8]) -> [UInt8] {
        precondition(key.count == 32)

        // r with clamping
        let t0 = load32(key, 0), t1 = load32(key, 4), t2 = load32(key, 8), t3 = load32(key, 12)
        let r0 = UInt64(t0 & 0x3FFFFFF)
        let r1 = UInt64(((t0 >> 26) | (t1 << 6)) & 0x3FFFF03)
        let r2 = UInt64(((t1 >> 20) | (t2 << 12)) & 0x3FFC0FF)
        let r3 = UInt64(((t2 >> 14) | (t3 << 18)) & 0x3F03FFF)
        let r4 = UInt64((t3 >> 8) & 0x00FFFFF)

        let s1 = r1 &* 5, s2 = r2 &* 5, s3 = r3 &* 5, s4 = r4 &* 5

        var h0: UInt64 = 0, h1: UInt64 = 0, h2: UInt64 = 0, h3: UInt64 = 0, h4: UInt64 = 0

        var offset = 0
        let len = message.count
        while offset < len {
            let n = min(16, len - offset)
            var block = [UInt8](repeating: 0, count: 17)
            for i in 0..<n { block[i] = message[offset + i] }
            block[n] = 1

            let b0 = load32(block, 0), b1 = load32(block, 4), b2 = load32(block, 8), b3 = load32(block, 12)
            let hibit = UInt64(block[16]) << 24

            h0 &+= UInt64(b0 & 0x3FFFFFF)
            h1 &+= UInt64(((b0 >> 26) | (b1 << 6)) & 0x3FFFFFF)
            h2 &+= UInt64(((b1 >> 20) | (b2 << 12)) & 0x3FFFFFF)
            h3 &+= UInt64(((b2 >> 14) | (b3 << 18)) & 0x3FFFFFF)
            h4 &+= UInt64(b3 >> 8) &+ hibit

            let d0 = h0 &* r0 &+ h1 &* s4 &+ h2 &* s3 &+ h3 &* s2 &+ h4 &* s1
            var d1 = h0 &* r1 &+ h1 &* r0 &+ h2 &* s4 &+ h3 &* s3 &+ h4 &* s2
            var d2 = h0 &* r2 &+ h1 &* r1 &+ h2 &* r0 &+ h3 &* s4 &+ h4 &* s3
            var d3 = h0 &* r3 &+ h1 &* r2 &+ h2 &* r1 &+ h3 &* r0 &+ h4 &* s4
            var d4 = h0 &* r4 &+ h1 &* r3 &+ h2 &* r2 &+ h3 &* r1 &+ h4 &* r0

            var c = d0 >> 26; h0 = d0 & 0x3FFFFFF
            d1 &+= c; c = d1 >> 26; h1 = d1 & 0x3FFFFFF
            d2 &+= c; c = d2 >> 26; h2 = d2 & 0x3FFFFFF
            d3 &+= c; c = d3 >> 26; h3 = d3 & 0x3FFFFFF
            d4 &+= c; c = d4 >> 26; h4 = d4 & 0x3FFFFFF
            h0 &+= c &* 5; c = h0 >> 26; h0 &= 0x3FFFFFF
            h1 &+= c

            offset += n
        }

        // full carry
        var c = h1 >> 26; h1 &= 0x3FFFFFF
        h2 &+= c; c = h2 >> 26; h2 &= 0x3FFFFFF
        h3 &+= c; c = h3 >> 26; h3 &= 0x3FFFFFF
        h4 &+= c; c = h4 >> 26; h4 &= 0x3FFFFFF
        h0 &+= c &* 5; c = h0 >> 26; h0 &= 0x3FFFFFF
        h1 &+= c

        // compute h + -p
        var g0 = h0 &+ 5; c = g0 >> 26; g0 &= 0x3FFFFFF
        var g1 = h1 &+ c; c = g1 >> 26; g1 &= 0x3FFFFFF
        var g2 = h2 &+ c; c = g2 >> 26; g2 &= 0x3FFFFFF
        var g3 = h3 &+ c; c = g3 >> 26; g3 &= 0x3FFFFFF
        var g4 = h4 &+ c &- (1 << 26)

        // select h if h < p, or h + -p if h >= p
        let mask = (g4 >> 63) &- 1
        g0 &= mask; g1 &= mask; g2 &= mask; g3 &= mask; g4 &= mask
        let notMask = ~mask
        h0 = (h0 & notMask) | g0
        h1 = (h1 & notMask) | g1
        h2 = (h2 & notMask) | g2
        h3 = (h3 & notMask) | g3
        h4 = (h4 & notMask) | g4

        // h = h % 2^128, then add pad s
        var f0 = ((h0) | (h1 << 26)) & 0xFFFFFFFF
        var f1 = ((h1 >> 6) | (h2 << 20)) & 0xFFFFFFFF
        var f2 = ((h2 >> 12) | (h3 << 14)) & 0xFFFFFFFF
        var f3 = ((h3 >> 18) | (h4 << 8)) & 0xFFFFFFFF

        f0 &+= UInt64(load32(key, 16))
        f1 &+= UInt64(load32(key, 20)) &+ (f0 >> 32)
        f2 &+= UInt64(load32(key, 24)) &+ (f1 >> 32)
        f3 &+= UInt64(load32(key, 28)) &+ (f2 >> 32)

        var tag = [UInt8](repeating: 0, count: 16)
        store32(UInt32(truncatingIfNeeded: f0), into: &tag, 0)
        store32(UInt32(truncatingIfNeeded: f1), into: &tag, 4)
        store32(UInt32(truncatingIfNeeded: f2), into: &tag, 8)
        store32(UInt32(truncatingIfNeeded: f3), into: &tag, 12)

        return tag
    }

    /// Constant-time tag comparison.
    static func verify(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == 16, b.count == 16 else { return false }
        var diff: UInt8 = 0
        for i in 0..<16 { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    private static func load32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        UInt32(bytes[offset])
            | (UInt32(bytes[offset + 1]) << 8)
            | (UInt32(bytes[offset + 2]) << 16)
            | (UInt32(bytes[offset + 3]) << 24)
    }

    private static func store32(_ word: UInt32, into out: inout [UInt8], _ offset: Int) {
        out[offset] = UInt8(truncatingIfNeeded: word)
        out[offset + 1] = UInt8(truncatingIfNeeded: word >> 8)
        out[offset + 2] = UInt8(truncatingIfNeeded: word >> 16)
        out[offset + 3] = UInt8(truncatingIfNeeded: word >> 24)
    }
}
