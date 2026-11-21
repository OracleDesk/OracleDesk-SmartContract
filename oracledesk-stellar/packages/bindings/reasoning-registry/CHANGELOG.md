# Changelog

## 0.1.1

- Added the `#325` delegated availability reporter interface:
  `set_availability_reporter`, `availability_reporter`, `report_unavailable`
  and `clear_unavailable`, the `AvailabilityReporterSet` event, the
  `Availability*` data keys, and errors 135-137. This is an additive interface
  change; existing methods and error codes are unchanged.

## 0.1.0

Initial versioned interface manifest and semantic compatibility baseline.
