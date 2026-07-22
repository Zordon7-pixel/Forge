import Capacitor
import Foundation
import Photos

@objc(ForgePhotosPlugin)
public class ForgePhotosPlugin: CAPPlugin, CAPBridgedPlugin {
    private enum ImageKind {
        case png
        case jpeg

        var dataURLPrefix: String {
            switch self {
            case .png: return "data:image/png;base64,"
            case .jpeg: return "data:image/jpeg;base64,"
            }
        }

        var fileExtension: String {
            switch self {
            case .png: return "png"
            case .jpeg: return "jpg"
            }
        }

        func matchesSignature(_ data: Data) -> Bool {
            switch self {
            case .png:
                return data.starts(with: Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
            case .jpeg:
                return data.starts(with: Data([0xFF, 0xD8, 0xFF]))
            }
        }
    }

    private let maximumImageBytes = 20 * 1024 * 1024

    public let identifier = "ForgePhotosPlugin"
    public let jsName = "ForgePhotos"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise)
    ]

    @objc func saveImage(_ call: CAPPluginCall) {
        guard let dataURL = call.getString("dataUrl"),
              let kind = imageKind(for: dataURL) else {
            call.reject("The share card must be a PNG or JPEG image.")
            return
        }
        let encoded = String(dataURL.dropFirst(kind.dataURLPrefix.count))
        let maximumEncodedLength = ((maximumImageBytes + 2) / 3) * 4
        guard !encoded.isEmpty,
              encoded.count <= maximumEncodedLength,
              let data = Data(base64Encoded: encoded),
              !data.isEmpty,
              data.count <= maximumImageBytes,
              kind.matchesSignature(data) else {
            call.reject("The share card image is invalid or too large.")
            return
        }

        let filename = safeFilename(call.getString("filename"), kind: kind)
        requestAddPermission { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async {
                    call.reject("Photos access is off. Allow Forged Hybrid to add photos in iPhone Settings.")
                }
                return
            }

            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = filename
                request.addResource(with: .photo, data: data, options: options)
            }) { success, error in
                DispatchQueue.main.async {
                    if let error = error {
                        call.reject(error.localizedDescription)
                    } else if success {
                        call.resolve(["saved": true])
                    } else {
                        call.reject("The share card could not be saved to Photos.")
                    }
                }
            }
        }
    }

    private func imageKind(for dataURL: String) -> ImageKind? {
        if dataURL.hasPrefix(ImageKind.png.dataURLPrefix) { return .png }
        if dataURL.hasPrefix(ImageKind.jpeg.dataURLPrefix) { return .jpeg }
        return nil
    }

    private func safeFilename(_ requested: String?, kind: ImageKind) -> String {
        let fallback = "forged-hybrid-run"
        let raw = URL(fileURLWithPath: requested ?? fallback).deletingPathExtension().lastPathComponent
        let sanitized = raw.replacingOccurrences(
            of: "[^A-Za-z0-9._-]+",
            with: "-",
            options: .regularExpression
        ).trimmingCharacters(in: CharacterSet(charactersIn: ".-_"))
        let base = sanitized.isEmpty ? fallback : String(sanitized.prefix(100))
        return "\(base).\(kind.fileExtension)"
    }

    private func requestAddPermission(_ completion: @escaping (PHAuthorizationStatus) -> Void) {
        if #available(iOS 14.0, *) {
            PHPhotoLibrary.requestAuthorization(for: .addOnly, handler: completion)
        } else {
            PHPhotoLibrary.requestAuthorization(completion)
        }
    }
}
