import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';

import '../../models/strike.dart';
import '../../services/live_strikes_controller.dart';
import '../../services/settings_controller.dart';
import '../../utils/age_gradient.dart';

/// Matches the FAQ copy on the web app: "Strikes younger than ten seconds
/// get a red ring." (app/page.tsx) — ported to the live map's dot layer.
const int kFreshMs = 10000;
const int kWindowMs = 30 * 60 * 1000;
const int kRingMs = 700;

class _Ring {
  final Offset origin;
  final int startMs;
  _Ring(this.origin, this.startMs);
}

/// Renders every live strike as an age-colored dot on a single CustomPaint
/// overlay (never per-point Markers — there can be tens of thousands of
/// points, which flutter_map's Marker layer cannot handle at speed).
class StrikeDotsLayer extends StatefulWidget {
  final MapController mapController;
  const StrikeDotsLayer({super.key, required this.mapController});

  @override
  State<StrikeDotsLayer> createState() => _StrikeDotsLayerState();
}

class _StrikeDotsLayerState extends State<StrikeDotsLayer> {
  Timer? _ticker;
  StreamSubscription<MapEvent>? _mapSub;
  StreamSubscription<List<Strike>>? _batchSub;
  final List<_Ring> _rings = [];
  int _now = DateTime.now().millisecondsSinceEpoch;
  int _lastSoundMs = 0;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
      _now = DateTime.now().millisecondsSinceEpoch;
      _rings.removeWhere((r) => _now - r.startMs > kRingMs);
      if (mounted) setState(() {});
    });
    _mapSub = widget.mapController.mapEventStream.listen((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _batchSub?.cancel();
    final controller = context.read<LiveStrikesController>();
    _batchSub = controller.newBatchStream.listen(_onBatch);
  }

  void _onBatch(List<Strike> batch) {
    if (batch.isEmpty) return;
    final camera = widget.mapController.camera;
    final sound = context.read<SettingsController>().sound;
    var played = 0;
    for (final s in batch) {
      final point = LatLng(s.lat, s.lon);
      if (!camera.visibleBounds.contains(point)) continue;
      final offset = camera.latLngToScreenOffset(point);
      _rings.add(_Ring(offset, _now));
      if (sound && played < 12 && _now - _lastSoundMs > 30) {
        _lastSoundMs = _now;
        played++;
        SystemSound.play(SystemSoundType.click);
      }
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _mapSub?.cancel();
    _batchSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strikes = context.watch<LiveStrikesController>().strikes;
    return IgnorePointer(
      child: CustomPaint(
        size: Size.infinite,
        painter: _StrikeDotsPainter(
          strikes: strikes,
          rings: List.of(_rings),
          camera: widget.mapController.camera,
          nowMs: _now,
        ),
      ),
    );
  }
}

class _StrikeDotsPainter extends CustomPainter {
  final List<Strike> strikes;
  final List<_Ring> rings;
  final MapCamera camera;
  final int nowMs;

  _StrikeDotsPainter({required this.strikes, required this.rings, required this.camera, required this.nowMs});

  @override
  void paint(Canvas canvas, Size size) {
    final bounds = camera.visibleBounds;
    final dotPaint = Paint()..style = PaintingStyle.fill;
    final ringStroke = Paint()..style = PaintingStyle.stroke;
    final freshStroke = Paint()
      ..style = PaintingStyle.stroke
      ..color = const Color(0xE6FF2222)
      ..strokeWidth = 1.8;

    for (final s in strikes) {
      final point = LatLng(s.lat, s.lon);
      if (!bounds.contains(point)) continue;
      final offset = camera.latLngToScreenOffset(point);
      final age = nowMs - s.time;
      if (age < 0) continue;

      if (age < kFreshMs) {
        final f = age / kFreshMs;
        final radius = 3.5 - 1.5 * f;
        dotPaint.color = Color.fromRGBO(255, (230 - 60 * f).round(), (64 - 30 * f).round(), 1 - 0.2 * f);
        canvas.drawCircle(offset, radius, dotPaint);
        if (f < 0.35) canvas.drawCircle(offset, radius, freshStroke);
      } else if (age < kWindowMs) {
        final t = (1 - age / kWindowMs).clamp(0.02, 1.0);
        dotPaint.color = ageColor(t);
        canvas.drawCircle(offset, 2, dotPaint);
      }
    }

    for (final r in rings) {
      final p = ((nowMs - r.startMs) / kRingMs).clamp(0.0, 1.0);
      if (p <= 0 || p >= 1) continue;
      final fade = math.pow(1 - p, 1.5).toDouble();
      ringStroke
        ..color = Color.fromRGBO(255, 220, 60, fade * 0.95)
        ..strokeWidth = 2.5 * (1 - p) + 0.5;
      canvas.drawCircle(r.origin, math.sqrt(p) * 40, ringStroke);
    }
  }

  @override
  bool shouldRepaint(covariant _StrikeDotsPainter oldDelegate) => true;
}
