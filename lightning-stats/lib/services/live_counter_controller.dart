import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api_config.dart';

/// Ports the Navbar's useNavCount(): a dedicated /ws socket (separate from the
/// /api/strikes SSE feed) broadcasting {total, viewers} on every connect.
class LiveCounterController extends ChangeNotifier {
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _reconnectTimer;
  Timer? _rateTimer;
  int _backoffMs = 1000;
  bool _disposed = false;

  int display = 0;
  int target = 0;
  bool connected = false;
  int viewers = 0;
  double strikeRate = 0;

  final List<_Sample> _rateBuf = [];
  bool _seeded = false;

  LiveCounterController() {
    _connect();
    _rateTimer = Timer.periodic(const Duration(milliseconds: 100), (_) => _tickDisplay());
  }

  void _connect() {
    if (_disposed) return;
    try {
      final channel = WebSocketChannel.connect(Uri.parse(kApiWsUrl));
      _channel = channel;
      _sub = channel.stream.listen(
        _onMessage,
        onDone: _onDisconnect,
        onError: (_) => _onDisconnect(),
        cancelOnError: true,
      );
      connected = true;
      _backoffMs = 1000;
      notifyListeners();
    } catch (_) {
      _onDisconnect();
    }
  }

  void _onMessage(dynamic raw) {
    try {
      final data = jsonDecode(raw as String) as Map<String, dynamic>;
      final total = data['total'];
      if (total is num) {
        target = total.toInt();
        if (!_seeded) {
          _seeded = true;
          display = target;
        }
        final now = DateTime.now().millisecondsSinceEpoch;
        _rateBuf.add(_Sample(target, now));
        final cutoff = now - 30000;
        while (_rateBuf.length > 1 && _rateBuf.first.ts < cutoff) {
          _rateBuf.removeAt(0);
        }
        if (_rateBuf.length >= 2) {
          final spanSec = (_rateBuf.last.ts - _rateBuf.first.ts) / 1000;
          if (spanSec > 0) {
            strikeRate = (_rateBuf.last.total - _rateBuf.first.total) / spanSec;
          }
        }
      }
      final v = data['viewers'];
      if (v is num) viewers = v.toInt();
      notifyListeners();
    } catch (_) {}
  }

  void _onDisconnect() {
    if (_disposed) return;
    connected = false;
    notifyListeners();
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(milliseconds: _backoffMs), _connect);
    _backoffMs = (_backoffMs * 2).clamp(1000, 30000);
  }

  void _tickDisplay() {
    if (display >= target) return;
    final delta = target - display;
    display += delta > 50 ? (delta / 20).ceil() : 1;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _rateTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    super.dispose();
  }
}

class _Sample {
  final int total;
  final int ts;
  _Sample(this.total, this.ts);
}
