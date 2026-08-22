import 'package:intl/intl.dart';

final NumberFormat _numberFormat = NumberFormat.decimalPattern();

String fmt(num n) => _numberFormat.format(n);

/// Strike rate: one decimal below 10/m, whole numbers above.
String fmtRate(double r) => r >= 10 ? r.round().toString() : r.toStringAsFixed(1);

/// Duration in ms as "2h 14m" / "45m".
String fmtDuration(int ms) {
  final mins = (ms / 60000).round();
  if (mins < 60) return '${mins}m';
  return '${mins ~/ 60}h ${mins % 60}m';
}

/// Epoch ms as 24-hour wall-clock time — always en-GB formatting, matching
/// the web app (the clock format intentionally doesn't localize with the UI language).
String fmtClock(int t, {bool seconds = false}) {
  final d = DateTime.fromMillisecondsSinceEpoch(t).toLocal();
  final h = d.hour.toString().padLeft(2, '0');
  final m = d.minute.toString().padLeft(2, '0');
  if (!seconds) return '$h:$m';
  final s = d.second.toString().padLeft(2, '0');
  return '$h:$m:$s';
}

String todayUtc() => DateTime.now().toUtc().toIso8601String().substring(0, 10);
