import SwiftUI
import CoreImage.CIFilterBuiltins
import TabsendKit

/// Shows a freshly minted complete pairing link as QR + copyable text.
struct PairSheetView: View {
    let pairing: AppModel.MintedPairing
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    // White behind the code in both modes, because a scanner wants
                    // dark-on-light. No outline or offset shadow: that look belongs
                    // to the first-run pairing screen only.
                    if let image = qrImage(for: pairing.qrLink) {
                        Image(uiImage: image)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 240)
                            .padding(16)
                            .background(
                                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white)
                            )
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .accessibilityLabel("Pairing QR code")
                            .panelRow()
                    }
                } footer: {
                    Text("Scan the QR with a phone, or copy the link to a browser extension. It works once and expires in about 10 minutes.")
                        .foregroundColor(Palette.muted)
                }

                Section {
                    Button {
                        UIPasteboard.general.string = pairing.link
                    } label: {
                        TileLabel(title: "Copy link", systemName: "doc.on.doc", tile: Palette.accentFill)
                    }
                    .panelRow()
                }
            }
            .groupedListBackground()
            .navigationTitle("Pair a device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button("Close") { dismiss() }
            }
        }
        .tint(Palette.accent)
    }

    private func qrImage(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        guard let cgImage = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
