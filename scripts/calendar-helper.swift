// Tells the app who a call is with. Run it with one word:
//   status   prints granted, denied or undetermined, and never prompts
//   request  raises the macOS prompt, then prints the result
//   now      prints events around this moment as JSON

import EventKit
import Foundation

let store = EKEventStore()

func status() -> String {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess, .authorized: return "granted"
  case .notDetermined: return "undetermined"
  default: return "denied"
  }
}

func request() -> String {
  let done = DispatchSemaphore(value: 0)
  var allowed = false
  store.requestFullAccessToEvents { granted, _ in
    allowed = granted
    done.signal()
  }
  done.wait()
  return allowed ? "granted" : "denied"
}

func eventsNow() -> String {
  let now = Date()
  let predicate = store.predicateForEvents(
    withStart: now.addingTimeInterval(-3 * 3600),
    end: now.addingTimeInterval(20 * 60),
    calendars: nil
  )
  let events: [[String: Any]] = store.events(matching: predicate).map { event in
    let people: [[String: Any]] = (event.attendees ?? []).map { person in
      let address = person.url.absoluteString
      return [
        "name": person.name ?? "",
        "email": address.hasPrefix("mailto:") ? String(address.dropFirst(7)) : "",
        "me": person.isCurrentUser,
      ]
    }
    return [
      "title": event.title ?? "",
      "start": event.startDate.timeIntervalSince1970,
      "end": event.endDate.timeIntervalSince1970,
      "allDay": event.isAllDay,
      "attendees": people,
    ]
  }
  guard let data = try? JSONSerialization.data(withJSONObject: events),
    let text = String(data: data, encoding: .utf8)
  else { return "[]" }
  return text
}

switch CommandLine.arguments.dropFirst().first {
case "status": print(status())
case "request": print(request())
case "now": print(status() == "granted" ? eventsNow() : "[]")
default:
  fputs("Usage: calendar-helper status|request|now\n", stderr)
  exit(2)
}
