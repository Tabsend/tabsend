package io.tabsend.app

import io.tabsend.app.logic.HomeNetwork
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Runs every case in `shared/vectors/home-network.json` (PLANS.md P-15 item 4),
 * the same file the extension's and iOS's tests run, so the three rules cannot
 * drift apart.
 */
class HomeNetworkTest {

    @Serializable
    private data class Case(val url: String, val home: Boolean, val why: String)

    @Serializable
    private data class Vectors(val cases: List<Case>)

    private val vectors: Vectors by lazy {
        Json { ignoreUnknownKeys = true }.decodeFromString(Vectors.serializer(), vectorFile().readText())
    }

    /** Walk up from wherever Gradle runs the test until the shared vector is found. */
    private fun vectorFile(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "shared/vectors/home-network.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        error("shared/vectors/home-network.json not found above ${File("").absolutePath}")
    }

    @Test
    fun `every shared vector case`() {
        assertTrue(vectors.cases.any { it.home })
        assertTrue(vectors.cases.any { !it.home })
        for (c in vectors.cases) {
            assertEquals("${c.url}: ${c.why}", c.home, HomeNetwork.isHomeNetworkRelay(c.url))
        }
    }

    @Test
    fun `the hint says why and what to do, without an em dash`() {
        val line = EN.string(R.string.relay_down_line_home_network, "http://192.168.1.20:8786", "5m ago")
        assertTrue(line.contains("home network"))
        assertTrue(line.contains("VPN"))
        assertFalse(line.contains("—"))
    }
}
