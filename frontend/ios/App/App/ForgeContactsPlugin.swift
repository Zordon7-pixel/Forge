import Capacitor
import Contacts
import Foundation

@objc(ForgeContactsPlugin)
public class ForgeContactsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForgeContactsPlugin"
    public let jsName = "ForgeContacts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestEmailAccess", returnType: CAPPluginReturnPromise)
    ]

    private let contactStore = CNContactStore()

    @objc func requestEmailAccess(_ call: CAPPluginCall) {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        if canReadContacts(status) {
            readEmails(call)
            return
        }
        guard status == .notDetermined else {
            call.reject("Contacts access is off. Allow it in iPhone Settings to find beta friends.")
            return
        }

        contactStore.requestAccess(for: .contacts) { granted, error in
            if let error = error {
                call.reject(error.localizedDescription)
                return
            }
            guard granted else {
                call.reject("Contacts access was not granted.")
                return
            }
            self.readEmails(call)
        }
    }

    private func canReadContacts(_ status: CNAuthorizationStatus) -> Bool {
        if status == .authorized { return true }
        if #available(iOS 18.0, *), status == .limited { return true }
        return false
    }

    private func readEmails(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            var emails = Set<String>()
            let request = CNContactFetchRequest(keysToFetch: [CNContactEmailAddressesKey as CNKeyDescriptor])
            request.unifyResults = true

            do {
                try self.contactStore.enumerateContacts(with: request) { contact, stop in
                    for value in contact.emailAddresses {
                        let email = String(value.value).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                        if !email.isEmpty { emails.insert(email) }
                    }
                    if emails.count >= 2_000 { stop.pointee = true }
                }
                DispatchQueue.main.async {
                    call.resolve(["emails": Array(emails).sorted()])
                }
            } catch {
                DispatchQueue.main.async {
                    call.reject(error.localizedDescription)
                }
            }
        }
    }
}
