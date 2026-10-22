/**
 * Recognising an uploaded image by its bytes.
 *
 * Every image upload (`api`'s saved images and custom avatar item files, `storage`'s
 * FileType 3) is served back by the `img` worker, which plays the stored content-type
 * straight to the browser. Nothing about the upload is trustworthy: the multipart part's
 * `type` and filename are whatever the client chose to send, so a `text/html` body under a
 * `.jpg` name is an HTML document on the image origin unless something looks at the bytes.
 * This does — the stored type and extension come from the signature, never the claim.
 */

/** What an image's leading bytes say it is. */
export interface SniffedImage {
	/** The media type to store and serve it under. */
	contentType: string
	/** The extension to key it with, dot included. */
	extension: string
}

interface Signature extends SniffedImage {
	/** Byte sequences that must appear at the given offsets. */
	parts: Array<{ offset: number; bytes: number[] }>
}

const ascii = (s: string): number[] => Array.from(s, (ch) => ch.charCodeAt(0))

/** The formats an upload may be — the set the `img` worker decodes and resizes. */
const SIGNATURES: Signature[] = [
	{
		contentType: 'image/png',
		extension: '.png',
		parts: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
	},
	{
		contentType: 'image/jpeg',
		extension: '.jpg',
		parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
	},
	{ contentType: 'image/gif', extension: '.gif', parts: [{ offset: 0, bytes: ascii('GIF8') }] },
	{
		contentType: 'image/webp',
		extension: '.webp',
		parts: [
			{ offset: 0, bytes: ascii('RIFF') },
			{ offset: 8, bytes: ascii('WEBP') },
		],
	},
	{ contentType: 'image/bmp', extension: '.bmp', parts: [{ offset: 0, bytes: ascii('BM') }] },
]

/** The formats `sniffImage` accepts, for an error message. */
export const SNIFFED_IMAGE_FORMATS = 'PNG, JPEG, GIF, WebP or BMP'

/**
 * Identify an image by its signature, or `undefined` when the bytes are not one of the
 * supported formats. Operates on the leading bytes only; it does not validate the rest.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
	const match = SIGNATURES.find(({ parts }) =>
		parts.every(({ offset, bytes: expected }) => expected.every((b, i) => bytes[offset + i] === b))
	)
	return match ? { contentType: match.contentType, extension: match.extension } : undefined
}
