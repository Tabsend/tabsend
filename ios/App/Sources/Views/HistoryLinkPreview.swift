import SwiftUI
import TabsendKit

/// What one row or card knows about its website so far.
struct LinkPreviewState {
    /// The page's own title, for a tab sent without one.
    var pageTitle: String?
    var slot: Slot

    enum Slot {
        /// Still asking. A plain tile; the row is already usable.
        case loading
        case picture(UIImage)
        /// No picture, a failed one, or Website images off: the site's first letter.
        case letter
    }
}

/// Loads one tab's picture and hands the state to `content`. Website images off, or a
/// link that may not be asked for, makes no request at all.
struct LinkPreviewReader<Content: View>: View {
    @EnvironmentObject private var model: AppModel

    let item: HistoryItem
    @ViewBuilder let content: (LinkPreviewState) -> Content

    @State private var preview: WebsitePreview?
    @State private var finished = false

    private var page: URL? {
        item.payload.flatMap { LinkURLPolicy.openableURL(from: $0.url) }
            .flatMap { LinkPreviewMetadata.eligible($0) ? $0 : nil }
    }

    private var hasTitle: Bool {
        guard let title = item.payload?.title else { return false }
        return !title.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var requests: Bool { model.websiteImagesOn && page != nil }

    private var state: LinkPreviewState {
        guard requests else { return LinkPreviewState(slot: .letter) }
        let title = preview?.title.flatMap { $0.isEmpty ? nil : $0 }
        if let image = preview?.image {
            return LinkPreviewState(pageTitle: title, slot: .picture(image))
        }
        return LinkPreviewState(pageTitle: title, slot: finished ? .letter : .loading)
    }

    var body: some View {
        content(state)
            .task(id: requests ? page : nil) {
                guard requests, let page else { return }
                let loaded = await WebsitePreviewLoader.shared.load(
                    page: page,
                    knownImage: LinkPreviewMetadata.usableImage(item.payload?.image),
                    hasTitle: hasTitle
                )
                guard !Task.isCancelled else { return }
                preview = loaded
                finished = true
            }
    }
}

/// The picture slot: never a broken-image icon, and the same footprint in every state.
struct SitePicture: View {
    let slot: LinkPreviewState.Slot
    let letter: String
    var letterFont: Font = .headline

    var body: some View {
        // The picture overlays a sized frame, so its own proportions never widen the row.
        Palette.slot
            .overlay {
                switch slot {
                case .picture(let image):
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                case .letter:
                    Text(letter)
                        .font(letterFont)
                        .foregroundColor(Palette.muted)
                case .loading:
                    EmptyView()
                }
            }
            .clipped()
            .accessibilityHidden(true)
    }
}
