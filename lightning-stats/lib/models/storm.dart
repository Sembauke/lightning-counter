import 'strike.dart';

/// One row from GET /api/storms?date=YYYY-MM-DD (storms list) or the
/// per-day/all-time records list (GET /api/records, GET /api/storms?live=1).
class StormLogRow {
  final String stormKey;
  final String code;
  final int count;
  final double rate;
  final double lat;
  final double lon;
  final String? city;
  final String date;
  final double? originLat;
  final double? originLon;
  final String? originCity;
  final int? startTime;
  final int? endTime;
  final double? traveledKm;
  final int? totalCount;
  final List<String>? countryPath;
  final String? originCode; // resolved server-side for cross-border storms
  final int? rank;
  final int? nextRankThreshold;
  final String? category; // present on /api/records rows only

  const StormLogRow({
    required this.stormKey,
    required this.code,
    required this.count,
    required this.rate,
    required this.lat,
    required this.lon,
    this.city,
    required this.date,
    this.originLat,
    this.originLon,
    this.originCity,
    this.startTime,
    this.endTime,
    this.traveledKm,
    this.totalCount,
    this.countryPath,
    this.originCode,
    this.rank,
    this.nextRankThreshold,
    this.category,
  });

  int get effectiveCount => totalCount ?? count;

  factory StormLogRow.fromJson(Map<String, dynamic> json) => StormLogRow(
        stormKey: json['stormKey'] as String,
        code: json['code'] as String,
        count: (json['count'] as num).toInt(),
        rate: (json['rate'] as num).toDouble(),
        lat: (json['lat'] as num).toDouble(),
        lon: (json['lon'] as num).toDouble(),
        city: json['city'] as String?,
        date: json['date'] as String,
        originLat: (json['originLat'] as num?)?.toDouble(),
        originLon: (json['originLon'] as num?)?.toDouble(),
        originCity: json['originCity'] as String?,
        startTime: (json['startTime'] as num?)?.toInt(),
        endTime: (json['endTime'] as num?)?.toInt(),
        traveledKm: (json['traveledKm'] as num?)?.toDouble(),
        totalCount: (json['totalCount'] as num?)?.toInt(),
        countryPath: (json['countryPath'] as List<dynamic>?)?.cast<String>(),
        originCode: json['originCode'] as String?,
        rank: (json['rank'] as num?)?.toInt(),
        nextRankThreshold: (json['nextRankThreshold'] as num?)?.toInt(),
        category: json['category'] as String?,
      );
}

/// A full storm record including its strike history, from
/// GET /api/storms?key=... (getStormByKey).
class BiggestStorm extends StormLogRow {
  final List<StormStrike>? strikes;

  const BiggestStorm({
    required super.stormKey,
    required super.code,
    required super.count,
    required super.rate,
    required super.lat,
    required super.lon,
    super.city,
    required super.date,
    super.originLat,
    super.originLon,
    super.originCity,
    super.startTime,
    super.endTime,
    super.traveledKm,
    super.totalCount,
    super.countryPath,
    this.strikes,
  });

  factory BiggestStorm.fromJson(Map<String, dynamic> json) => BiggestStorm(
        stormKey: json['stormKey'] as String? ?? '',
        code: json['code'] as String,
        count: (json['count'] as num).toInt(),
        rate: (json['rate'] as num).toDouble(),
        lat: (json['lat'] as num).toDouble(),
        lon: (json['lon'] as num).toDouble(),
        city: json['city'] as String?,
        date: json['date'] as String,
        originLat: (json['originLat'] as num?)?.toDouble(),
        originLon: (json['originLon'] as num?)?.toDouble(),
        originCity: json['originCity'] as String?,
        startTime: (json['startTime'] as num?)?.toInt(),
        endTime: (json['endTime'] as num?)?.toInt(),
        traveledKm: (json['traveledKm'] as num?)?.toDouble(),
        totalCount: (json['totalCount'] as num?)?.toInt(),
        countryPath: (json['countryPath'] as List<dynamic>?)?.cast<String>(),
        strikes: StormStrike.listFromJson(json['strikes'] as List<dynamic>?),
      );
}

/// One of the ten storms ranked immediately above/below a given storm globally.
class RankedNeighbor {
  final String stormKey;
  final int rank;
  final String code;
  final double lat;
  final double lon;
  final String? city;
  final String? originCity;
  final String date;
  final int totalCount;

  const RankedNeighbor({
    required this.stormKey,
    required this.rank,
    required this.code,
    required this.lat,
    required this.lon,
    this.city,
    this.originCity,
    required this.date,
    required this.totalCount,
  });

  RankedNeighbor copyWith({int? rank, int? totalCount}) => RankedNeighbor(
        stormKey: stormKey,
        rank: rank ?? this.rank,
        code: code,
        lat: lat,
        lon: lon,
        city: city,
        originCity: originCity,
        date: date,
        totalCount: totalCount ?? this.totalCount,
      );

  factory RankedNeighbor.fromJson(Map<String, dynamic> json) => RankedNeighbor(
        stormKey: json['stormKey'] as String,
        rank: (json['rank'] as num).toInt(),
        code: json['code'] as String,
        lat: (json['lat'] as num).toDouble(),
        lon: (json['lon'] as num).toDouble(),
        city: json['city'] as String?,
        originCity: json['originCity'] as String?,
        date: json['date'] as String,
        totalCount: (json['totalCount'] as num).toInt(),
      );
}

/// GET /api/storms/[key]/strikes — polled every 15s on a live storm's detail page.
class StormStrikesResponse {
  final List<StormStrike> strikes;
  final int? endTime;
  final int? totalCount;
  final int count;
  final double rate;
  final int? startTime;
  final double? traveledKm;
  final String? city;
  final String? originCity;
  final List<RankedNeighbor> nearbyRanked;

  const StormStrikesResponse({
    required this.strikes,
    this.endTime,
    this.totalCount,
    required this.count,
    required this.rate,
    this.startTime,
    this.traveledKm,
    this.city,
    this.originCity,
    required this.nearbyRanked,
  });

  factory StormStrikesResponse.fromJson(Map<String, dynamic> json) => StormStrikesResponse(
        strikes: StormStrike.listFromJson(json['strikes'] as List<dynamic>?),
        endTime: (json['endTime'] as num?)?.toInt(),
        totalCount: (json['totalCount'] as num?)?.toInt(),
        count: (json['count'] as num).toInt(),
        rate: (json['rate'] as num).toDouble(),
        startTime: (json['startTime'] as num?)?.toInt(),
        traveledKm: (json['traveledKm'] as num?)?.toDouble(),
        city: json['city'] as String?,
        originCity: json['originCity'] as String?,
        nearbyRanked: (json['nearbyRanked'] as List<dynamic>? ?? [])
            .map((e) => RankedNeighbor.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// A lightweight live-storm entry from GET /api/storms?live=1, used to match
/// tracked-storm SSE keys against global rank on the live map.
class LiveStormSummary {
  final String stormKey;
  final double lat;
  final double lon;
  final int? rank;
  final int? nextRankThreshold;
  final int? totalCount;
  final int count;

  const LiveStormSummary({
    required this.stormKey,
    required this.lat,
    required this.lon,
    this.rank,
    this.nextRankThreshold,
    this.totalCount,
    required this.count,
  });

  int get effectiveCount => totalCount ?? count;

  factory LiveStormSummary.fromJson(Map<String, dynamic> json) => LiveStormSummary(
        stormKey: json['stormKey'] as String,
        lat: (json['lat'] as num).toDouble(),
        lon: (json['lon'] as num).toDouble(),
        rank: (json['rank'] as num?)?.toInt(),
        nextRankThreshold: (json['nextRankThreshold'] as num?)?.toInt(),
        totalCount: (json['totalCount'] as num?)?.toInt(),
        count: (json['count'] as num).toInt(),
      );
}

/// GET /api/records response.
class RecordsResponse {
  final List<StormLogRow> storms; // category != 'most': biggest/longest/farthest
  final List<StormLogRow> dailyBest;

  const RecordsResponse({required this.storms, required this.dailyBest});

  factory RecordsResponse.fromJson(Map<String, dynamic> json) => RecordsResponse(
        storms: (json['storms'] as List<dynamic>? ?? [])
            .map((e) => StormLogRow.fromJson(e as Map<String, dynamic>))
            .toList(),
        dailyBest: (json['dailyBest'] as List<dynamic>? ?? [])
            .map((e) => StormLogRow.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}
