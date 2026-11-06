package io.tabsend.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/** Preview requests are separate from the paired relay client: no cookies,
 * credentials, redirects or pinned-relay headers cross into website traffic. */
internal object HistoryPreviews {
    /** Says who is asking, as link previews do. OkHttp's default name is refused by many sites. */
    private val USER_AGENT = "Tabsend/${io.tabsend.app.BuildConfig.VERSION_NAME} (+https://tabsend.org)"
    /** [retryAt] is set on a failure that may pass (no signal), so it isn't remembered for good. */
    data class Preview(val title: String?, val image: Bitmap?, val retryAt: Long = 0L)

    private const val FAILURE_RETRY_MS = 5 * 60_000L
    private const val MAX_IMAGE_ADDRESS = 2048
    private const val SEND_LOOKUP_MS = 1_500L
    private const val PICTURE_PX = 480

    private val cache = object : LruCache<String, Preview>(16 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Preview): Int =
            1024 + (value.image?.allocationByteCount ?: 0)
    }
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

    /** A picture address from a sealed payload or a page, or null when it fails the preview rule. */
    fun usableImage(raw: String?): String? =
        raw?.takeIf { it.length <= MAX_IMAGE_ADDRESS && eligible(it) }

    private suspend fun fetch(raw: String, image: Boolean): ByteArray? {
        currentCoroutineContext().ensureActive()
        if (!eligible(raw)) return null
        return client.newCall(Request.Builder().url(raw).header("Accept", if (image) "image/*" else "text/html").header("User-Agent", USER_AGENT).build())
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

    /** The most pixels a picture may have to be decoded; the iPhone uses the same number (review HP2). */
    private const val MAX_PIXELS = 16_000_000L

    private const val MAX_META_TAG = 4096
    private const val MAX_META_OPENINGS = 200

    /**
     * The `<meta ...>` tags of [html], found by plain search. A pattern like `<meta[^>]*>` runs
     * to the end of the page from every `<meta` that has no `>`, which is quadratic: a hostile
     * page could keep the phone busy for minutes (security review v0.11.0, HP1). A tag longer
     * than [MAX_META_TAG] is skipped, and only [MAX_META_OPENINGS] openings are looked at.
     */
    internal fun metaTags(html: String): List<String> {
        val tags = ArrayList<String>()
        var seen = 0
        var from = 0
        while (seen < MAX_META_OPENINGS && from < html.length) {
            val open = html.indexOf("<meta", from, ignoreCase = true)
            if (open < 0) break
            seen++
            from = open + 5
            if (from >= html.length) break
            val next = html[from]
            // "<metadata" is not a meta tag.
            if (next.isLetterOrDigit() || next == '_') continue
            val close = html.substring(from, minOf(html.length, from + MAX_META_TAG)).indexOf('>')
            if (close < 0) continue
            tags.add(html.substring(open, from + close + 1))
            from += close + 1
        }
        return tags
    }

    /**
     * Whether the phone may request the linked page itself to find its picture or title. Not when
     * the address carries a query string or a fragment: that is where one-time tokens live
     * ("confirm your email", sign-in and "view once" links), and the request would use them up
     * before the person taps (security review v0.11.0, HP3). The picture address a sender passes
     * along is still fetched; only the page is left alone.
     */
    fun mayRequestPage(raw: String): Boolean = eligible(raw) && !raw.contains('?') && !raw.contains('#')

    /** Attribute order, quote style and entities vary between real OG producers. */
    fun metadata(html: String): Map<String, String> {
        val result = mutableMapOf<String, String>()
        // The key may only start where a run of name characters starts: without that, a long run
        // with no `=` is tried from every position in it, which is quadratic (review HP1).
        val attributes = Regex("""(?<![\w:-])([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""")
        for (tag in metaTags(html)) {
            val attrs = attributes.findAll(tag).associate { match ->
                match.groupValues[1].lowercase() to match.groupValues.drop(2).firstOrNull { it.isNotEmpty() }.orEmpty()
            }
            val key = (attrs["property"] ?: attrs["name"])?.lowercase() ?: continue
            // One past the limit on a picture address, so a longer one fails usableImage
            // rather than being cut into a different address.
            val cap = if (key.endsWith(":image")) MAX_IMAGE_ADDRESS + 1 else 500
            attrs["content"]?.let { result.putIfAbsent(key, it.replace("&amp;", "&").replace("&quot;", "\"")
                .replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").take(cap)) }
        }
        return result
    }

    /** The page's picture address from its metadata, resolved against the page. */
    fun imageFrom(meta: Map<String, String>, pageUrl: String): String? =
        (meta["og:image"] ?: meta["twitter:image"])
            ?.let { pageUrl.toHttpUrlOrNull()?.resolve(it)?.toString() }
            ?.let(::usableImage)

    /**
     * The picture address a tab carries when this phone sends it, or null. Held to
     * [SEND_LOOKUP_MS] whatever the network does, including a stuck name lookup that the
     * HTTP timeouts cannot end: the lookup runs apart from the caller, which stops
     * waiting and sends without a picture.
     */
    suspend fun findImage(raw: String): String? {
        if (!mayRequestPage(raw)) return null
        val lookup = CoroutineScope(Dispatchers.IO).async {
            try {
                fetch(raw, false)?.toString(Charsets.UTF_8)?.let { imageFrom(metadata(it), raw) }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { null }
        }
        return withTimeoutOrNull(SEND_LOOKUP_MS) { lookup.await() }.also { lookup.cancel() }
    }

    private fun remembered(raw: String): Preview? =
        cache.get(raw)?.takeIf { it.retryAt == 0L || System.currentTimeMillis() < it.retryAt }

    /**
     * The picture for a tab, and the page's title when [needTitle]. A [knownImage] the
     * sender found saves asking the page at all, unless the tab has no title of its own.
     */
    suspend fun load(raw: String, knownImage: String? = null, needTitle: Boolean = false): Preview? = withContext(Dispatchers.IO) {
        remembered(raw)?.let { return@withContext it }
        if (!eligible(raw)) return@withContext null
        slots.withPermit {
            remembered(raw)?.let { return@withPermit it }
            try {
                val known = usableImage(knownImage)
                val meta = if ((known != null && !needTitle) || !mayRequestPage(raw)) {
                    emptyMap()
                } else {
                    fetch(raw, false)?.toString(Charsets.UTF_8)?.let(::metadata).orEmpty()
                }
                val imageUrl = known ?: imageFrom(meta, raw)
                val bytes: ByteArray? = imageUrl?.let {
                    try { fetch(it, true) }
                    catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                    catch (_: Exception) { null }
                }
                val bitmap = bytes?.let {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(it, 0, it.size, bounds)
                    if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > MAX_PIXELS) null
                    else {
                        val options = BitmapFactory.Options().apply {
                            inSampleSize = (maxOf(bounds.outWidth, bounds.outHeight) / PICTURE_PX).coerceAtLeast(1)
                        }
                        BitmapFactory.decodeByteArray(it, 0, it.size, options)
                    }
                }
                currentCoroutineContext().ensureActive()
                Preview(meta["og:title"], bitmap).also { cache.put(raw, it) }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) {
                Preview(null, null, System.currentTimeMillis() + FAILURE_RETRY_MS).also { cache.put(raw, it) }
            }
        }
    }
}
