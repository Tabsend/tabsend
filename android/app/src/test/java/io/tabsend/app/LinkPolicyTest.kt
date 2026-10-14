package io.tabsend.app

import io.tabsend.app.receive.LinkPolicy
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkPolicyTest {
    @Test
    fun `allows ordinary web links`() {
        assertTrue(LinkPolicy.isOpenableWebUrl("https://example.com/path?q=1"))
        assertTrue(LinkPolicy.isOpenableWebUrl("http://127.0.0.1:8786/page"))
        assertTrue(LinkPolicy.isOpenableWebUrl("HTTPS://example.com"))
    }

    @Test
    fun `rejects privileged and malformed links`() {
        assertFalse(LinkPolicy.isOpenableWebUrl("javascript:alert(1)"))
        assertFalse(LinkPolicy.isOpenableWebUrl("data:text/html,hello"))
        assertFalse(LinkPolicy.isOpenableWebUrl("file:///etc/passwd"))
        assertFalse(LinkPolicy.isOpenableWebUrl("intent://example.com"))
        assertFalse(LinkPolicy.isOpenableWebUrl("tabsend://join?c=secret"))
        assertFalse(LinkPolicy.isOpenableWebUrl("not a url"))
        assertFalse(LinkPolicy.isOpenableWebUrl(""))
        assertFalse(LinkPolicy.isOpenableWebUrl(null))
    }
}
