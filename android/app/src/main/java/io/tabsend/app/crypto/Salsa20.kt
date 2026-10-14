package io.tabsend.app.crypto

import org.bouncycastle.crypto.engines.Salsa20Engine
import org.bouncycastle.crypto.engines.XSalsa20Engine
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV

/**
 * The symmetric half of NaCl's `crypto_box` — HSalsa20 (key derivation) + the XSalsa20
 * keystream — now built on **Bouncy Castle's vetted Salsa20** (Chunk 6b). The prior
 * hand-rolled Salsa20 core (double-rounds, block function, keystream loop) is gone; the
 * bug-prone round arithmetic that runs over message-length data is BC's.
 *
 * Two BC seams are used, both stable public API in bcprov-jdk18on:
 *  - `XSalsa20Engine` produces the full XSalsa20 keystream (it does the HSalsa20 subkey
 *    derivation for the 24-byte nonce internally) — this is what encrypts/decrypts.
 *  - `Salsa20Engine.salsaCore(20, …)` is the vetted 20-round core; we reuse it for the
 *    standalone HSalsa20 that `crypto_box_beforenm` needs (BC exposes no public HSalsa20),
 *    undoing salsaCore's feed-forward add and extracting the HSalsa20 output words.
 *
 * Byte-for-byte equivalence to libsodium is pinned by the committed interop vector
 * (CryptoInteropTest) — any deviation fails the build loudly.
 */
internal object Salsa20 {
    /** "expand 32-byte k" — the Salsa20 sigma constant for 32-byte keys. */
    private val SIGMA = byteArrayOf(
        101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107,
    )

    private fun load32(src: ByteArray, off: Int): Int =
        (src[off].toInt() and 0xff) or
            ((src[off + 1].toInt() and 0xff) shl 8) or
            ((src[off + 2].toInt() and 0xff) shl 16) or
            ((src[off + 3].toInt() and 0xff) shl 24)

    private fun store32(dst: ByteArray, off: Int, v: Int) {
        dst[off] = v.toByte()
        dst[off + 1] = (v ushr 8).toByte()
        dst[off + 2] = (v ushr 16).toByte()
        dst[off + 3] = (v ushr 24).toByte()
    }

    /**
     * crypto_core_hsalsa20(out32, in16, key32, sigma). NaCl HSalsa20: 20 rounds with NO
     * feed-forward, output words {0,5,10,15,6,7,8,9} little-endian.
     *
     * We build the 16-word Salsa20 input state, run BC's vetted `salsaCore` (which does
     * the 20 rounds AND adds the input back — the standard Salsa20 feed-forward), then
     * SUBTRACT the input to recover the pure post-rounds words HSalsa20 wants.
     */
    fun hsalsa20(input16: ByteArray, key32: ByteArray): ByteArray {
        val state = IntArray(16)
        state[0] = load32(SIGMA, 0)
        state[1] = load32(key32, 0)
        state[2] = load32(key32, 4)
        state[3] = load32(key32, 8)
        state[4] = load32(key32, 12)
        state[5] = load32(SIGMA, 4)
        state[6] = load32(input16, 0)
        state[7] = load32(input16, 4)
        state[8] = load32(input16, 8)
        state[9] = load32(input16, 12)
        state[10] = load32(SIGMA, 8)
        state[11] = load32(key32, 16)
        state[12] = load32(key32, 20)
        state[13] = load32(key32, 24)
        state[14] = load32(key32, 28)
        state[15] = load32(SIGMA, 12)

        val withFeedForward = IntArray(16)
        Salsa20Engine.salsaCore(20, state, withFeedForward)

        val out = ByteArray(32)
        // rounds(state)[i] = salsaCore(state)[i] - state[i]; take HSalsa20's output words.
        store32(out, 0, withFeedForward[0] - state[0])
        store32(out, 4, withFeedForward[5] - state[5])
        store32(out, 8, withFeedForward[10] - state[10])
        store32(out, 12, withFeedForward[15] - state[15])
        store32(out, 16, withFeedForward[6] - state[6])
        store32(out, 20, withFeedForward[7] - state[7])
        store32(out, 24, withFeedForward[8] - state[8])
        store32(out, 28, withFeedForward[9] - state[9])
        return out
    }

    /**
     * XSalsa20 keystream of `len` bytes for a 24-byte nonce + 32-byte key, via BC's
     * `XSalsa20Engine` (which derives the HSalsa20 subkey from nonce[0..15] and runs
     * Salsa20 from nonce[16..23] with a zero-based block counter). Processing an all-zero
     * buffer yields the raw keystream, which the caller XORs with the message.
     */
    fun xsalsa20Keystream(len: Int, nonce24: ByteArray, key32: ByteArray): ByteArray {
        val engine = XSalsa20Engine()
        engine.init(true, ParametersWithIV(KeyParameter(key32), nonce24))
        val out = ByteArray(len)
        engine.processBytes(ByteArray(len), 0, len, out, 0)
        return out
    }
}
