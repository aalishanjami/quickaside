// Prints which apps have the microphone open, as one JSON array per line,
// whenever that changes. It reads Core Audio's process list (macOS 14.2+). It
// never touches audio, so it needs no permission.

import CoreAudio
import Darwin
import Foundation

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
}

func audioProcesses() -> [AudioObjectID]? {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var list = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &list, 0, nil, &size) == noErr else { return nil }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &list, 0, nil, &size, &ids) == noErr else { return nil }
  return ids
}

func hasInputRunning(_ id: AudioObjectID) -> Bool {
  var running = address(kAudioProcessPropertyIsRunningInput)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(id, &running, 0, nil, &size, &value) == noErr && value != 0
}

// The bundle id, or the executable path for a process that has none.
func identity(_ id: AudioObjectID) -> String {
  var bundle = address(kAudioProcessPropertyBundleID)
  var name: Unmanaged<CFString>? = nil
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  if AudioObjectGetPropertyData(id, &bundle, 0, nil, &size, &name) == noErr,
    let value = name?.takeRetainedValue() as String?, !value.isEmpty
  {
    return value
  }
  var pidAddress = address(kAudioProcessPropertyPID)
  var pid: pid_t = 0
  var pidSize = UInt32(MemoryLayout<pid_t>.size)
  guard AudioObjectGetPropertyData(id, &pidAddress, 0, nil, &pidSize, &pid) == noErr else { return "" }
  var path = [CChar](repeating: 0, count: 4096)
  return proc_pidpath(pid, &path, UInt32(path.count)) > 0 ? String(cString: path) : ""
}

var last: [String]? = nil
while getppid() != 1 {  // the app is gone, so stop too
  guard let processes = audioProcesses() else {
    fputs("Core Audio has no process list on this macOS.\n", stderr)
    exit(2)
  }
  let current = Array(Set(processes.filter(hasInputRunning).map(identity))).filter { !$0.isEmpty }.sorted()
  if current != last {
    last = current
    if let data = try? JSONSerialization.data(withJSONObject: current),
      let line = String(data: data, encoding: .utf8)
    {
      print(line)
      fflush(stdout)
    }
  }
  usleep(1_500_000)
}
