import Capacitor
import Foundation
import Photos

@objc(ForgePhotosPlugin)
public class ForgePhotosPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForgePhotosPlugin"
    public let jsName = "ForgePhotos"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise)
    ]

    @objc func saveImage(_ call: CAPPluginCall) {
        guard let dataUrl = call.getString("dataUrl"),
              let separator = dataUrl.firstIndex(of: ","),
              dataUrl[..<separator].contains(";base64"),
              let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: separator)...]), options: .ignoreUnknownCharacters),
              !data.isEmpty,
              data.count <= 20 * 1024 * 1024 else {
            call.reject("The share card image is invalid or too large.")
            return
        }

        let rawFilename = URL(fileURLWithPath: call.getString("filename") ?? "forged-hybrid-run.jpg").lastPathComponent
        let filename = String(rawFilename.prefix(120))
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

    private func requestAddPermission(_ completion: @escaping (PHAuthorizationStatus) -> Void) {
        if #available(iOS 14.0, *) {
            PHPhotoLibrary.requestAuthorization(for: .addOnly, handler: completion)
        } else {
            PHPhotoLibrary.requestAuthorization(completion)
        }
    }
}
