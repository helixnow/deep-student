import Foundation
import Vision

do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(macOS 13.0, *) {
        request.automaticallyDetectsLanguage = true
    }
    try VNImageRequestHandler(data: data).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    FileHandle.standardOutput.write(Data(text.utf8))
} catch {
    FileHandle.standardError.write(Data(error.localizedDescription.utf8))
    exit(1)
}
