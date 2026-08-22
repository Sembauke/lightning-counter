import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class SseEvent {
  final String event; // 'message' when unnamed, matching browser EventSource
  final String data;

  const SseEvent(this.event, this.data);
}

/// Minimal Server-Sent-Events client: connects, parses `event:`/`data:` fields
/// (blank line terminates a message), and reconnects with backoff on drop —
/// mirroring the browser EventSource behavior the web app relies on.
class SseClient {
  final Uri uri;
  final http.Client _client;
  StreamSubscription<String>? _sub;
  bool _closed = false;
  int _backoffMs = 1000;

  final _eventsController = StreamController<SseEvent>.broadcast();
  final _connectedController = StreamController<bool>.broadcast();

  SseClient(this.uri, {http.Client? client}) : _client = client ?? http.Client();

  Stream<SseEvent> get events => _eventsController.stream;
  Stream<bool> get connected => _connectedController.stream;

  void connect() {
    _closed = false;
    _open();
  }

  Future<void> _open() async {
    if (_closed) return;
    try {
      final request = http.Request('GET', uri)..headers['Accept'] = 'text/event-stream';
      final response = await _client.send(request);
      if (response.statusCode != 200) {
        _scheduleReconnect();
        return;
      }
      _backoffMs = 1000;
      _connectedController.add(true);

      String eventName = 'message';
      final dataLines = <String>[];

      void dispatch() {
        if (dataLines.isNotEmpty) {
          _eventsController.add(SseEvent(eventName, dataLines.join('\n')));
        }
        eventName = 'message';
        dataLines.clear();
      }

      _sub = response.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
        (line) {
          if (line.isEmpty) {
            dispatch();
            return;
          }
          if (line.startsWith(':')) return; // heartbeat/comment
          if (line.startsWith('event:')) {
            eventName = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.add(line.substring(5).trim());
          }
        },
        onError: (_) => _handleDrop(),
        onDone: _handleDrop,
        cancelOnError: true,
      );
    } catch (_) {
      _handleDrop();
    }
  }

  void _handleDrop() {
    if (_closed) return;
    _connectedController.add(false);
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed) return;
    Future.delayed(Duration(milliseconds: _backoffMs), _open);
    _backoffMs = (_backoffMs * 2).clamp(1000, 30000);
  }

  void close() {
    _closed = true;
    _sub?.cancel();
    _connectedController.add(false);
  }

  void dispose() {
    close();
    _eventsController.close();
    _connectedController.close();
  }
}
