import 'package:flutter/material.dart';

/// Shared strike-age gradient: t=0 -> oldest (dark purple), t=1 -> newest (yellow).
/// Ported 1:1 from app/lib/ageGradient.ts so live-map and replay dots match the web app.
class _Stop {
  final double pos;
  final int r, g, b;
  final double a;
  const _Stop(this.pos, this.r, this.g, this.b, this.a);
}

const List<_Stop> _stops = [
  _Stop(0, 30, 0, 80, 0.20),
  _Stop(0.30, 120, 0, 160, 0.42),
  _Stop(0.55, 210, 10, 10, 0.65),
  _Stop(0.78, 255, 120, 0, 0.80),
  _Stop(1, 255, 230, 0, 0.92),
];

Color ageColor(double t) {
  var i = 0;
  while (i < _stops.length - 2 && _stops[i + 1].pos <= t) {
    i++;
  }
  final s0 = _stops[i];
  final s1 = _stops[i + 1];
  final f = s1.pos > s0.pos ? (t - s0.pos) / (s1.pos - s0.pos) : 0.0;
  final r = (s0.r + f * (s1.r - s0.r)).round();
  final g = (s0.g + f * (s1.g - s0.g)).round();
  final b = (s0.b + f * (s1.b - s0.b)).round();
  final a = s0.a + f * (s1.a - s0.a);
  return Color.fromRGBO(r, g, b, a);
}
