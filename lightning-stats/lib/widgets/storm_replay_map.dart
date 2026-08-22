import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../models/strike.dart';
import '../theme/app_theme.dart';
import '../utils/age_gradient.dart';
import '../utils/format.dart';
import '../utils/replay_timing.dart';

const _satUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const _labelsUrl =
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const List<double> _dimMatrix = [
  0.55, 0, 0, 0, 0, //
  0, 0.55, 0, 0, 0,
  0, 0, 0.55, 0, 0,
  0, 0, 0, 1, 0,
];

const int kReplayFreshMs = 20000;
const int kReplayRingMs = 600;
const int kMaxRingsReplay = 12;
const int kTargetRingCount = 60;
const int kGradientRefMs = 4 * 60 * 60 * 1000;
const int kGapMs = 2 * 60 * 60 * 1000;

class _Ring {
  final Offset origin;
  final int startMs;
  _Ring(this.origin, this.startMs);
}

/// Ports StormReplayMap.tsx: a satellite map with all of a storm's strikes
/// drawn on a single CustomPaint overlay, either played back on a scrubber
/// (finished storms) or continuously aged in real time (`isLive`).
class StormReplayMap extends StatefulWidget {
  final List<StormStrike> strikes;
  final List<StormStrike>? appendedStrikes;
  final bool isLive;

  const StormReplayMap({super.key, required this.strikes, this.appendedStrikes, this.isLive = false});

  @override
  State<StormReplayMap> createState() => _StormReplayMapState();
}

class _StormReplayMapState extends State<StormReplayMap> with SingleTickerProviderStateMixin {
  final MapController _mapController = MapController();
  late Ticker _ticker;
  bool _mapReady = false;

  late List<StormStrike> _all;
  int _minTime = 0, _maxTime = 0;
  int _replayMinTime = 0;
  int _replayMs = kReplayMsMin;
  double _freshMs = 1200;
  int _ringEvery = 1;
  int _gradientRef = kGradientRefMs;

  bool _playing = false;
  double _progress = 0; // 0..1, only meaningful when not playing/live
  int _playStartMs = 0; // elapsed-ms clock at play() start, offset by progress
  final List<_Ring> _rings = [];
  int _lastAppendedLen = 0;
  int _nowMs = 0;

  @override
  void initState() {
    super.initState();
    _recompute();
    _ticker = createTicker(_onTick)..start();
  }

  @override
  void didUpdateWidget(covariant StormReplayMap old) {
    super.didUpdateWidget(old);
    if (widget.appendedStrikes != null &&
        widget.appendedStrikes!.length > _lastAppendedLen) {
      final fresh = widget.appendedStrikes!.sublist(_lastAppendedLen);
      _lastAppendedLen = widget.appendedStrikes!.length;
      _all.addAll(fresh);
      if (_mapReady) {
        final now = DateTime.now().millisecondsSinceEpoch;
        for (final s in fresh) {
          final offset = _mapController.camera.latLngToScreenOffset(LatLng(s.lat, s.lon));
          _rings.add(_Ring(offset, now));
          if (s.time > _maxTime) _maxTime = s.time;
        }
      }
    }
    if (old.strikes != widget.strikes) _recompute();
  }

  void _recompute() {
    _all = List.of(widget.strikes);
    if (_all.isEmpty) return;
    _minTime = _all.map((s) => s.time).reduce(math.min);
    _maxTime = _all.map((s) => s.time).reduce(math.max);

    final times = _all.map((s) => s.time).toList()..sort();
    var replayMin = times.first;
    for (var i = 0; i < times.length - 1; i++) {
      if (times[i + 1] - times[i] < kGapMs) {
        replayMin = times[i];
        break;
      }
    }
    _replayMinTime = replayMin;
    final spanMs = math.max(1, _maxTime - replayMin);
    _replayMs = computeReplayDurationMs(spanMs);
    _freshMs = computeFreshMs(spanMs, _replayMs);
    _ringEvery = math.max(1, (times.length / kTargetRingCount).round());
    _gradientRef = math.max(kGradientRefMs, _maxTime - _minTime);
  }

  void _onTick(Duration elapsed) {
    final now = DateTime.now().millisecondsSinceEpoch;
    _nowMs = now;
    _rings.removeWhere((r) => now - r.startMs > (widget.isLive ? 700 : kReplayRingMs));

    if (widget.isLive) {
      setState(() {});
      return;
    }
    if (_playing) {
      final elapsedMs = now - _playStartMs;
      final p = (elapsedMs / _replayMs).clamp(0.0, 1.0);
      _progress = p;
      _maybeSpawnRings(p);
      if (p >= 1) _playing = false;
      setState(() {});
    }
  }

  void _maybeSpawnRings(double progress) {
    if (!_mapReady) return;
    final cutoff = cutoffForProgress(progress, _replayMinTime, _maxTime);
    var i = 0;
    for (final s in _all) {
      if (s.time > cutoff) break;
      if (i % _ringEvery == 0 && _rings.length < kMaxRingsReplay) {
        final offset = _mapController.camera.latLngToScreenOffset(LatLng(s.lat, s.lon));
        _rings.add(_Ring(offset, _nowMs));
      }
      i++;
    }
  }

  void _play() {
    if (_playing || _all.isEmpty) return;
    final start = _progress >= 1 ? 0.0 : _progress;
    _playStartMs = DateTime.now().millisecondsSinceEpoch - (start * _replayMs).round();
    setState(() => _playing = true);
  }

  void _fitBounds() {
    if (_all.isEmpty) return;
    double minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (final s in _all) {
      if (s.lat < minLat) minLat = s.lat;
      if (s.lat > maxLat) maxLat = s.lat;
      if (s.lon < minLon) minLon = s.lon;
      if (s.lon > maxLon) maxLon = s.lon;
    }
    final bounds = LatLngBounds(LatLng(minLat, minLon), LatLng(maxLat, maxLon));
    _mapController.fitCamera(CameraFit.bounds(bounds: bounds, padding: const EdgeInsets.all(24), maxZoom: 8));
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_all.isEmpty) {
      return const SizedBox(
        height: 160,
        child: Center(child: Text('Replay not available — strike data is kept for 7 days.',
            style: TextStyle(color: AppColors.textSecondary, fontSize: 12))),
      );
    }

    final cutoff = widget.isLive
        ? DateTime.now().millisecondsSinceEpoch
        : cutoffForProgress(_progress, _replayMinTime, _maxTime);
    final windowStart = widget.isLive ? null : cutoff - kGradientRefMs;
    final freshMs = widget.isLive ? 10000.0 : _freshMs;
    final ageRef = widget.isLive ? _gradientRef : kGradientRefMs;

    return SizedBox(
      height: 220,
      child: Stack(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: FlutterMap(
              mapController: _mapController,
              options: MapOptions(
                initialCenter: LatLng(_all.first.lat, _all.first.lon),
                initialZoom: 6,
                minZoom: 4,
                maxZoom: 12,
                interactionOptions: InteractionOptions(
                  flags: widget.isLive ? InteractiveFlag.none : InteractiveFlag.all,
                ),
                onMapReady: () {
                  _mapReady = true;
                  WidgetsBinding.instance.addPostFrameCallback((_) => _fitBounds());
                  if (mounted) setState(() {});
                },
              ),
              children: [
                ColorFiltered(
                  colorFilter: const ColorFilter.matrix(_dimMatrix),
                  child: TileLayer(urlTemplate: _satUrl, userAgentPackageName: 'com.lightningstats.lightning_stats'),
                ),
                Opacity(
                  opacity: 0.75,
                  child: TileLayer(urlTemplate: _labelsUrl, userAgentPackageName: 'com.lightningstats.lightning_stats'),
                ),
                // Guarded on _mapReady: the MapController isn't attached until
                // FlutterMap has completed its first build, so reading
                // `.camera` any earlier (e.g. inline in this build() call)
                // throws — this child's own build() runs after that point.
                if (_mapReady)
                  IgnorePointer(
                    child: CustomPaint(
                      size: Size.infinite,
                      painter: _ReplayPainter(
                        strikes: _all,
                        rings: List.of(_rings),
                        camera: _mapController.camera,
                        cutoff: cutoff,
                        nowMs: _nowMs,
                        freshMs: freshMs,
                        windowStart: windowStart,
                        ageRef: ageRef,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          Positioned(
            top: 6,
            left: 8,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(4)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (widget.isLive) const Text('●  ', style: TextStyle(color: Colors.redAccent, fontSize: 10)),
                Text(
                  widget.isLive
                      ? fmtClock(cutoff, seconds: true)
                      : (_playing
                          ? fmtClock(cutoff, seconds: true)
                          : '${fmtClock(_minTime)} – ${fmtClock(_maxTime)}'),
                  style: const TextStyle(color: Colors.white, fontSize: 11),
                ),
              ]),
            ),
          ),
          if (widget.isLive)
            const Positioned(
              top: 6,
              right: 8,
              child: Text('● LIVE', style: TextStyle(color: Colors.redAccent, fontSize: 11, fontWeight: FontWeight.bold)),
            )
          else
            Positioned(
              left: 4,
              right: 4,
              bottom: 0,
              child: Row(
                children: [
                  IconButton(
                    icon: Icon(_playing ? Icons.pause : Icons.play_arrow, color: AppColors.accent, size: 20),
                    onPressed: _playing ? null : _play,
                  ),
                  Expanded(
                    child: SliderTheme(
                      data: SliderTheme.of(context).copyWith(
                        trackHeight: 2,
                        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                      ),
                      child: Slider(
                        value: _progress.clamp(0.0, 1.0),
                        activeColor: AppColors.accent,
                        inactiveColor: AppColors.border,
                        onChangeStart: (_) => setState(() => _playing = false),
                        onChanged: (v) => setState(() => _progress = v),
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _ReplayPainter extends CustomPainter {
  final List<StormStrike> strikes;
  final List<_Ring> rings;
  final MapCamera camera;
  final int cutoff;
  final int nowMs;
  final double freshMs;
  final int? windowStart;
  final int ageRef;

  _ReplayPainter({
    required this.strikes,
    required this.rings,
    required this.camera,
    required this.cutoff,
    required this.nowMs,
    required this.freshMs,
    required this.windowStart,
    required this.ageRef,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final dotPaint = Paint()..style = PaintingStyle.fill;
    final freshStroke = Paint()
      ..style = PaintingStyle.stroke
      ..color = const Color(0xE6FF2222)
      ..strokeWidth = 1.8;
    final ringPaint = Paint()..style = PaintingStyle.stroke;

    for (final s in strikes) {
      if (s.time > cutoff) continue;
      if (windowStart != null && s.time < windowStart!) continue;
      final offset = camera.latLngToScreenOffset(LatLng(s.lat, s.lon));
      final age = cutoff - s.time;
      if (age < freshMs) {
        final f = freshMs > 0 ? age / freshMs : 1.0;
        final radius = 3.5 - 1.5 * f;
        dotPaint.color = Color.fromRGBO(255, (230 - 60 * f).round(), (64 - 30 * f).round(), 1 - 0.2 * f);
        canvas.drawCircle(offset, radius, dotPaint);
        if (f < 0.35) canvas.drawCircle(offset, radius, freshStroke);
      } else {
        final t = (1 - age / ageRef).clamp(0.12, 1.0);
        dotPaint.color = ageColor(t);
        canvas.drawCircle(offset, 2, dotPaint);
      }
    }

    for (final r in rings) {
      final p = ((nowMs - r.startMs) / kReplayRingMs).clamp(0.0, 1.0);
      if (p <= 0 || p >= 1) continue;
      final fade = math.pow(1 - p, 1.5).toDouble();
      ringPaint
        ..color = Color.fromRGBO(255, 220, 60, fade * 0.95)
        ..strokeWidth = 2.5 * (1 - p) + 0.5;
      canvas.drawCircle(r.origin, math.sqrt(p) * 40, ringPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _ReplayPainter oldDelegate) => true;
}
