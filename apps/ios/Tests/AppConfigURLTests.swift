import Foundation
import Testing
@testable import Waffled

@Suite struct AppConfigURLTests {
    @Test func normalizesValidHTTPOrigins() {
        #expect(AppConfig.normalizedApiBaseURL("  https://family.example.com/  ") == "https://family.example.com")
        #expect(AppConfig.normalizedApiBaseURL("http://192.168.1.50:8080") == "http://192.168.1.50:8080")
        #expect(AppConfig.normalizedApiBaseURL("HTTP://LOCALHOST:8080/") == "http://localhost:8080")
    }

    @Test func rejectsMalformedAndUnsupportedServerAddresses() {
        #expect(AppConfig.normalizedApiBaseURL("family.example.com") == nil)
        #expect(AppConfig.normalizedApiBaseURL("ftp://family.example.com") == nil)
        #expect(AppConfig.normalizedApiBaseURL("https:///missing-host") == nil)
        #expect(AppConfig.normalizedApiBaseURL("https://user:secret@family.example.com") == nil)
        #expect(AppConfig.normalizedApiBaseURL("https://family.example.com/path") == nil)
        #expect(AppConfig.normalizedApiBaseURL("https://family.example.com?debug=1") == nil)
    }

    @Test func buildsRequestURLsWithoutStringForceUnwraps() {
        let url = AppConfig.apiURL(path: "/api/auth/status", baseURL: "https://family.example.com")
        #expect(url?.absoluteString == "https://family.example.com/api/auth/status")
        #expect(AppConfig.apiURL(path: "/api/auth/status", baseURL: "not a server") == nil)
    }
}
