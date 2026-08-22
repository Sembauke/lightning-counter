/// A single lightning strike shown on the live map.
class Strike {
  final String id;
  final double lat;
  final double lon;
  final int time; // epoch ms
  final String? cc;

  const Strike({required this.id, required this.lat, required this.lon, required this.time, this.cc});

  factory Strike.fromLiveJson(Map<String, dynamic> json, String id) => Strike(
        id: id,
        lat: (json['lat'] as num).toDouble(),
        lon: (json['lon'] as num).toDouble(),
        time: (json['time'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
        cc: json['cc'] as String?,
      );
}

/// A live-tracked storm summary, broadcast over the /api/strikes SSE `storms` event.
class TrackedStormSummary {
  final String key;
  final double lat;
  final double lon;
  final int totalStrikes;
  final String cc;
  final double rate;
  final int rank;
  final bool hasPage;

  const TrackedStormSummary({
    required this.key,
    required this.lat,
    required this.lon,
    required this.totalStrikes,
    required this.cc,
    required this.rate,
    required this.rank,
    required this.hasPage,
  });

  factory TrackedStormSummary.fromJson(Map<String, dynamic> json) => TrackedStormSummary(
        key: json['key'] as String,
        lat: (json['lat'] as num).toDouble(),
        lon: (json['lon'] as num).toDouble(),
        totalStrikes: (json['totalStrikes'] as num).toInt(),
        cc: json['cc'] as String? ?? '',
        rate: (json['rate'] as num?)?.toDouble() ?? 0,
        rank: (json['rank'] as num).toInt(),
        hasPage: json['hasPage'] as bool? ?? false,
      );
}

/// A single [lat, lon, timeMs] tuple as stored/transmitted for storm replays.
class StormStrike {
  final double lat;
  final double lon;
  final int time;

  const StormStrike({required this.lat, required this.lon, required this.time});

  factory StormStrike.fromJson(List<dynamic> json) => StormStrike(
        lat: (json[0] as num).toDouble(),
        lon: (json[1] as num).toDouble(),
        time: (json[2] as num).toInt(),
      );

  static List<StormStrike> listFromJson(List<dynamic>? json) =>
      json?.map((e) => StormStrike.fromJson(e as List<dynamic>)).toList() ?? [];
}
