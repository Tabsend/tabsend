package io.tabsend.app.ui

import android.os.Bundle
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView

/**
 * zxing's scan screen with the camera focusing all the time.
 *
 * Out of the box zxing asks the camera to focus once, then again every two seconds
 * ("auto" mode). On many current phones that never settles on a code held close, so
 * the scanner sat blurry while the phone's own camera app read the same code at once
 * [2026-10-14, v0.7.1 on the owner's phone]. Continuous focus is what camera apps use;
 * zxing falls back to "auto" on a camera that lacks it.
 */
class QrScanActivity : CaptureActivity() {
    private lateinit var scannerView: DecoratedBarcodeView

    override fun initializeContent(): DecoratedBarcodeView =
        super.initializeContent().also { scannerView = it }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // After super: it replaces the camera settings with ones read from the intent.
        // The camera itself opens later, in onResume.
        scannerView.barcodeView.cameraSettings.isContinuousFocusEnabled = true
    }
}
