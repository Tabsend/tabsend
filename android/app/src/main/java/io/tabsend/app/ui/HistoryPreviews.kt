package io.tabsend.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/** Preview requests are separate from the paired relay client: no cookies,
 * credentials, redirects or pinned-relay headers cross into website traffic. */
internal object HistoryPreviews {
    data class Preview(val title: String?, val description: String?, val image: Bitmap?)
    private val cache = LruCache<String, Preview>(48)
    private val slots = Semaphore(3)
    private val client = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .callTimeout(8, TimeUnit.SECONDS)
        .dns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> =
                Dns.SYSTEM.lookup(hostname).also { addresses ->
                    if (addresses.isEmpty() || !addresses.all(::publicAddress)) {
                        throw java.net.UnknownHostException("Preview address is not public")
                    }
                }
        }).build()

    private fun publicAddress(address: InetAddress): Boolean =
        !address.isAnyLocalAddress && !address.isLoopbackAddress &&
            !address.isLinkLocalAddress && !address.isSiteLocalAddress &&
            !address.isMulticastAddress &&
            !(address.address.size == 16 && (address.address[0].toInt() and 0xfe) == 0xfc) &&
            !(address.address.size == 4 && address.address[0].toInt() and 255 == 100 &&
                address.address[1].toInt() and 255 in 64..127)

    fun eligible(raw: String): Boolean {
        val url = raw.toHttpUrlOrNull() ?: return false
        return url.isHttps && url.port == 443 && url.username.isEmpty() && url.password.isEmpty() &&
            url.host.contains('.') && url.host.any { it.isLetter() } &&
            url.host.substringAfterLast('.') !in setOf("local", "localhost", "internal", "test", "invalid")
    }

    private suspend fun fetch(raw: String, image: Boolean): ByteArray? {
        currentCoroutineContext().ensureActive()
        if (!eligible(raw)) return null
        return client.newCall(Request.Builder().url(raw).header("Accept", if (image) "image/*" else "text/html").build())
            .execute().use { response ->
                val body = response.body ?: return null
                val type = body.contentType()?.toString().orEmpty()
                if (!response.isSuccessful || !(if (image) type.startsWith("image/") else type.startsWith("text/html"))) return null
                val limit = if (image) 2_000_000 else 512_000
                body.byteStream().use { stream ->
                    val result = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = stream.read(buffer)
                        if (count < 0) break
                        if (result.size() + count > limit) {
                            if (image) return null
                            break
                        }
                        result.write(buffer, 0, count)
                        if (!image && result.toString("UTF-8").contains("</head>", ignoreCase = true)) break
                    }
                    result.toByteArray()
                }
            }
    }

    /** Attribute order, quote style and entities vary between real OG producers. */
    fun metadata(html: String): Map<String, String> {
        val result = mutableMapOf<String, String>()
        val attributes = Regex("""([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""")
        for (tag in Regex("<meta\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(html)) {
            val attrs = attributes.findAll(tag.value).associate { match ->
                match.groupValues[1].lowercase() to match.groupValues.drop(2).firstOrNull { it.isNotEmpty() }.orEmpty()
            }
            val key = (attrs["property"] ?: attrs["name"])?.lowercase() ?: continue
            attrs["content"]?.let { result.putIfAbsent(key, it.replace("&amp;", "&").replace("&quot;", "\"")
                .replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").take(500)) }
        }
        return result
    }

    suspend fun load(raw: String): Preview? = withContext(Dispatchers.IO) {
        cache.get(raw)?.let { return@withContext it }
        if (!eligible(raw)) return@withContext null
        slots.withPermit {
            cache.get(raw)?.let { return@withPermit it }
            try {
                val html = fetch(raw, false)?.toString(Charsets.UTF_8)
                    ?: return@withPermit Preview(null, null, null).also { cache.put(raw, it) }
                val meta = metadata(html)
                val imageUrl = meta["og:image"]?.let { raw.toHttpUrlOrNull()?.resolve(it)?.toString() }
                val bytes: ByteArray? = imageUrl?.let {
                    try { fetch(it, true) }
                    catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                    catch (_: Exception) { null }
                }
                val bitmap = bytes?.let {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(it, 0, it.size, bounds)
                    if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > 40_000_000) null
                    else {
                        val options = BitmapFactory.Options().apply {
                            inSampleSize = (maxOf(bounds.outWidth, bounds.outHeight) / 320).coerceAtLeast(1)
                        }
                        BitmapFactory.decodeByteArray(it, 0, it.size, options)
                    }
                }
                currentCoroutineContext().ensureActive()
                Preview(meta["og:title"], meta["og:description"] ?: meta["description"], bitmap).also { cache.put(raw, it) }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { Preview(null, null, null).also { cache.put(raw, it) } }
        }
    }
}
