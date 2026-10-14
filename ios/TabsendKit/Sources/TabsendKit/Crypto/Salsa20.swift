import Foundation

/// Salsa20 primitives needed for NaCl crypto_box: the core permutation,
/// HSalsa20 (key derivation, no feed-forward), and the XSalsa20 keystream.
/// Mirrors android/app/src/main/java/io/tabsend/app/crypto/Salsa20.kt.
enum Salsa20 {
    /// "expand 32-byte k"
    private static let sigma: [UInt32] = [0x6170_7865, 0x3320_646E, 0x7962_2D32, 0x6B20_6574]

    private static func rotl(_ v: UInt32, _ c: UInt32) -> UInt32 {
        (v &<< c) | (v &>> (32 - c))
    }

    /// 20 rounds of the Salsa20 core, WITHOUT the final feed-forward addition.
    private static func core(_ input: [UInt32]) -> [UInt32] {
        var x = input
        for _ in stride(from: 0, to: 20, by: 2) {
            // column round
            x[4] ^= rotl(x[0] &+ x[12], 7)
            x[8] ^= rotl(x[4] &+ x[0], 9)
            x[12] ^= rotl(x[8] &+ x[4], 13)
            x[0] ^= rotl(x[12] &+ x[8], 18)
            x[9] ^= rotl(x[5] &+ x[1], 7)
            x[13] ^= rotl(x[9] &+ x[5], 9)
            x[1] ^= rotl(x[13] &+ x[9], 13)
            x[5] ^= rotl(x[1] &+ x[13], 18)
            x[14] ^= rotl(x[10] &+ x[6], 7)
            x[2] ^= rotl(x[14] &+ x[10], 9)
            x[6] ^= rotl(x[2] &+ x[14], 13)
            x[10] ^= rotl(x[6] &+ x[2], 18)
            x[3] ^= rotl(x[15] &+ x[11], 7)
            x[7] ^= rotl(x[3] &+ x[15], 9)
            x[11] ^= rotl(x[7] &+ x[3], 13)
            x[15] ^= rotl(x[11] &+ x[7], 18)
            // row round
            x[1] ^= rotl(x[0] &+ x[3], 7)
            x[2] ^= rotl(x[1] &+ x[0], 9)
            x[3] ^= rotl(x[2] &+ x[1], 13)
            x[0] ^= rotl(x[3] &+ x[2], 18)
            x[6] ^= rotl(x[5] &+ x[4], 7)
            x[7] ^= rotl(x[6] &+ x[5], 9)
            x[4] ^= rotl(x[7] &+ x[6], 13)
            x[5] ^= rotl(x[4] &+ x[7], 18)
            x[11] ^= rotl(x[10] &+ x[9], 7)
            x[8] ^= rotl(x[11] &+ x[10], 9)
            x[9] ^= rotl(x[8] &+ x[11], 13)
            x[10] ^= rotl(x[9] &+ x[8], 18)
            x[12] ^= rotl(x[15] &+ x[14], 7)
            x[13] ^= rotl(x[12] &+ x[15], 9)
            x[14] ^= rotl(x[13] &+ x[12], 13)
            x[15] ^= rotl(x[14] &+ x[13], 18)
        }
        return x
    }

    private static func loadLE(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        UInt32(bytes[offset])
            | (UInt32(bytes[offset + 1]) << 8)
            | (UInt32(bytes[offset + 2]) << 16)
            | (UInt32(bytes[offset + 3]) << 24)
    }

    private static func storeLE(_ word: UInt32, into out: inout [UInt8], _ offset: Int) {
        out[offset] = UInt8(truncatingIfNeeded: word)
        out[offset + 1] = UInt8(truncatingIfNeeded: word >> 8)
        out[offset + 2] = UInt8(truncatingIfNeeded: word >> 16)
        out[offset + 3] = UInt8(truncatingIfNeeded: word >> 24)
    }

    /// HSalsa20(key, input16) -> 32-byte derived key.
    /// State layout: [σ0, k0..k3, σ1, in0..in3, σ2, k4..k7, σ3]; output words {0,5,10,15,6,7,8,9}.
    static func hsalsa20(key: [UInt8], input: [UInt8]) -> [UInt8] {
        precondition(key.count == 32 && input.count == 16)
        var state = [UInt32](repeating: 0, count: 16)
        state[0] = sigma[0]
        state[5] = sigma[1]
        state[10] = sigma[2]
        state[15] = sigma[3]
        for i in 0..<4 {
            state[1 + i] = loadLE(key, i * 4)
            state[11 + i] = loadLE(key, 16 + i * 4)
            state[6 + i] = loadLE(input, i * 4)
        }
        let z = core(state)
        var out = [UInt8](repeating: 0, count: 32)
        let picks = [0, 5, 10, 15, 6, 7, 8, 9]
        for (i, w) in picks.enumerated() {
            storeLE(z[w], into: &out, i * 4)
        }
        return out
    }

    /// XSalsa20 keystream: derive a subkey via HSalsa20 over nonce[0..16], then
    /// run the Salsa20 stream (with feed-forward) using nonce[16..24] and a
    /// little-endian block counter starting at 0.
    static func xsalsa20Keystream(key: [UInt8], nonce: [UInt8], length: Int) -> [UInt8] {
        precondition(key.count == 32 && nonce.count == 24)
        let subkey = hsalsa20(key: key, input: Array(nonce[0..<16]))
        var state = [UInt32](repeating: 0, count: 16)
        state[0] = sigma[0]
        state[5] = sigma[1]
        state[10] = sigma[2]
        state[15] = sigma[3]
        for i in 0..<4 {
            state[1 + i] = loadLE(subkey, i * 4)
            state[11 + i] = loadLE(subkey, 16 + i * 4)
        }
        state[6] = loadLE(Array(nonce[16..<24]), 0)
        state[7] = loadLE(Array(nonce[16..<24]), 4)

        var out = [UInt8](repeating: 0, count: length)
        var counter: UInt64 = 0
        var offset = 0
        while offset < length {
            state[8] = UInt32(truncatingIfNeeded: counter)
            state[9] = UInt32(truncatingIfNeeded: counter >> 32)
            let z = core(state)
            var block = [UInt8](repeating: 0, count: 64)
            for i in 0..<16 {
                storeLE(z[i] &+ state[i], into: &block, i * 4)
            }
            let n = min(64, length - offset)
            out.replaceSubrange(offset..<(offset + n), with: block[0..<n])
            offset += n
            counter += 1
        }
        return out
    }
}
