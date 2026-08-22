import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../models/strike.dart';
import 'api_config.dart';
import 'sse_client.dart';

/// Must hold at least the storm widget's full 5-min window at peak rates (~100/s).
const int kMaxStrikes = 40000;
const Duration kStrikeLifetime = Duration(minutes: 30);
// Strikes can arrive at 30-100/sec globally — batching keeps rebuilds at ~1/sec.
const Duration kFlushInterval = Duration(milliseconds: 800);

/// Ports app/hooks/useBlitzortung.ts: consumes the /api/strikes SSE feed and
/// exposes the same rolling state (recent strikes, totals, tracked storms).
class LiveStrikesController extends ChangeNotifier {
  final SseClient _sse = SseClient(Uri.parse('$kApiBaseUrl/api/strikes'));
  StreamSubscription<SseEvent>? _eventsSub;
  StreamSubscription<bool>? _connSub;
  Timer? _flushTimer;
  Timer? _cleanupTimer;
  int _counter = 0;

  List<Strike> strikes = [];
  int totalCount = 0;
  Map<String, int> countryCounts = {};
  bool connected = false;
  bool historyLoaded = false;
  List<TrackedStormSummary> trackedStorms = [];

  List<Strike> _pending = [];
  final Map<String, int> _pendingCounts = {};

  LiveStrikesController() {
    _connSub = _sse.connected.listen((c) {
      connected = c;
      notifyListeners();
    });
    _eventsSub = _sse.events.listen(_onEvent);
    _sse.connect();

    _flushTimer = Timer.periodic(kFlushInterval, (_) => _flush());
    _cleanupTimer = Timer.periodic(const Duration(seconds: 30), (_) => _cleanup());
  }

  void _onEvent(SseEvent e) {
    switch (e.event) {
      case 'init':
        try {
          final data = jsonDecode(e.data) as Map<String, dynamic>;
          totalCount = (data['total'] as num?)?.toInt() ?? 0;
          countryCounts = (data['countries'] as Map<String, dynamic>? ?? {})
              .map((k, v) => MapEntry(k, (v as num).toInt()));
        } catch (_) {}
        historyLoaded = true;
        notifyListeners();
        break;
      case 'history':
        try {
          final data = jsonDecode(e.data) as List<dynamic>;
          strikes = data.map((s) {
            final m = s as Map<String, dynamic>;
            return Strike.fromLiveJson(m, 'hist-${_counter++}');
          }).toList();
        } catch (_) {}
        notifyListeners();
        break;
      case 'storms':
        try {
          final data = jsonDecode(e.data) as List<dynamic>;
          trackedStorms =
              data.map((s) => TrackedStormSummary.fromJson(s as Map<String, dynamic>)).toList();
        } catch (_) {}
        notifyListeners();
        break;
      case 'status':
        connected = e.data == 'live';
        notifyListeners();
        break;
      default: // unnamed 'message' event: a single strike
        try {
          final data = jsonDecode(e.data) as Map<String, dynamic>;
          final strike = Strike.fromLiveJson(data, '${_counter++}');
          _pending.add(strike);
          final cc = data['cc'] as String?;
          if (cc != null) {
            _pendingCounts[cc] = (_pendingCounts[cc] ?? 0) + 1;
          }
        } catch (_) {}
    }
  }

  final _newBatchController = StreamController<List<Strike>>.broadcast();
  /// Emits each flush's freshly-arrived strikes — used by the map's dot layer
  /// to spawn ring animations / tick sounds without diffing the full list.
  Stream<List<Strike>> get newBatchStream => _newBatchController.stream;

  void _flush() {
    var changed = false;
    if (_pending.isNotEmpty) {
      final batch = _pending.reversed.toList(); // newest first
      _pending = [];
      final next = [...batch, ...strikes];
      strikes = next.length > kMaxStrikes ? next.sublist(0, kMaxStrikes) : next;
      changed = true;
      _newBatchController.add(batch);
    }
    if (_pendingCounts.isNotEmpty) {
      final next = Map<String, int>.from(countryCounts);
      for (final entry in _pendingCounts.entries) {
        next[entry.key] = (next[entry.key] ?? 0) + entry.value;
      }
      _pendingCounts.clear();
      countryCounts = next;
      changed = true;
    }
    if (changed) notifyListeners();
  }

  void _cleanup() {
    final cutoff = DateTime.now().subtract(kStrikeLifetime).millisecondsSinceEpoch;
    final before = strikes.length;
    strikes = strikes.where((s) => s.time > cutoff).toList();
    if (strikes.length != before) notifyListeners();
  }

  @override
  void dispose() {
    _flushTimer?.cancel();
    _cleanupTimer?.cancel();
    _eventsSub?.cancel();
    _connSub?.cancel();
    _sse.dispose();
    _newBatchController.close();
    super.dispose();
  }
}
