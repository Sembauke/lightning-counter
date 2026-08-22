import 'storm.dart';

/// One row from GET /api/archive — per-country live totals, refreshed every 2.5s.
class ArchiveRow {
  final String code;
  final int total;
  final int today;
  final int peakCount;
  final String peakDate;
  final double peakRate;

  const ArchiveRow({
    required this.code,
    required this.total,
    required this.today,
    required this.peakCount,
    required this.peakDate,
    required this.peakRate,
  });

  factory ArchiveRow.fromJson(Map<String, dynamic> json) => ArchiveRow(
        code: json['code'] as String,
        total: (json['total'] as num).toInt(),
        today: (json['today'] as num).toInt(),
        peakCount: (json['peakCount'] as num).toInt(),
        peakDate: json['peakDate'] as String? ?? '',
        peakRate: (json['peakRate'] as num?)?.toDouble() ?? 0,
      );
}

class CountryHistoryRow {
  final String date;
  final int count;

  const CountryHistoryRow({required this.date, required this.count});

  factory CountryHistoryRow.fromJson(Map<String, dynamic> json) => CountryHistoryRow(
        date: json['date'] as String,
        count: (json['count'] as num).toInt(),
      );
}

/// GET /api/country/[code] response.
class CountryDetail {
  final List<CountryHistoryRow> history;
  final BiggestStorm? biggestStorm;

  const CountryDetail({required this.history, this.biggestStorm});

  factory CountryDetail.fromJson(Map<String, dynamic> json) => CountryDetail(
        history: (json['history'] as List<dynamic>? ?? [])
            .map((e) => CountryHistoryRow.fromJson(e as Map<String, dynamic>))
            .toList(),
        biggestStorm: json['biggestStorm'] != null
            ? BiggestStorm.fromJson(json['biggestStorm'] as Map<String, dynamic>)
            : null,
      );
}
