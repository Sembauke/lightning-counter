import 'package:flutter/material.dart';

import '../l10n/app_strings.dart';
import '../models/storm.dart';
import '../theme/app_theme.dart';
import '../utils/format.dart';
import '../utils/storm_naming.dart';
import 'country_flag.dart';

String _tier(int? rank) {
  if (rank == null) return '';
  if (rank == 1) return 'gold';
  if (rank == 2) return 'silver';
  if (rank == 3) return 'bronze';
  if (rank <= 10) return 'top10';
  return '';
}

const Map<String, Color> _tierColors = {
  'gold': Color(0xFFFFD700),
  'silver': Color(0xFFC0C0C0),
  'bronze': Color(0xFFCD7F32),
  'top10': AppColors.accentDim,
};

/// Shared storm list row — used by the Storms log, Records lists, and can be
/// reused anywhere a StormLogRow needs a compact tappable summary.
class StormRow extends StatelessWidget {
  final StormLogRow storm;
  final int? rank;
  final bool isLive;
  final VoidCallback onTap;

  const StormRow({super.key, required this.storm, this.rank, this.isLive = false, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final ts = AppStrings.of(context);
    final name = stormLabel(ts, city: storm.city, originCity: storm.originCity, code: storm.code, lat: storm.lat, lon: storm.lon);
    final tier = _tier(rank);
    final rankColor = _tierColors[tier];
    final hasDuration = storm.startTime != null && storm.endTime != null;

    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: AppColors.border)),
          color: isLive ? AppColors.accent.withValues(alpha: 0.04) : null,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            if (rank != null)
              Padding(
                padding: const EdgeInsets.only(right: 10),
                child: Text('#$rank', style: TextStyle(color: rankColor ?? AppColors.textSecondary, fontWeight: FontWeight.bold, fontSize: 15)),
              ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(child: Text(name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
                      if (isLive) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                          decoration: BoxDecoration(color: Colors.redAccent.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(6)),
                          child: const Text('LIVE', style: TextStyle(color: Colors.redAccent, fontSize: 11, fontWeight: FontWeight.bold)),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      ..._flags(),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          [
                            '${fmtRate(storm.rate)}/m',
                            if (hasDuration) fmtDuration(storm.endTime! - storm.startTime!),
                            if (storm.traveledKm != null && storm.traveledKm! >= 5) '${storm.traveledKm!.round()}km',
                            storm.date,
                          ].join(' · '),
                          style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(fmt(storm.effectiveCount), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.accent)),
                const Text('strikes', style: TextStyle(fontSize: 11, color: AppColors.textSecondary)),
              ],
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _flags() {
    final path = storm.countryPath;
    if (path != null && path.length > 1) {
      final widgets = <Widget>[];
      for (var i = 0; i < path.length; i++) {
        if (i > 0) widgets.add(const Padding(padding: EdgeInsets.symmetric(horizontal: 3), child: Text('›', style: TextStyle(color: AppColors.textSecondary, fontSize: 12))));
        widgets.add(CountryFlag(code: path[i], width: 18));
      }
      return widgets;
    }
    if (storm.originCode != null && storm.originCode != storm.code) {
      return [
        CountryFlag(code: storm.originCode!, width: 18),
        const Padding(padding: EdgeInsets.symmetric(horizontal: 3), child: Text('›', style: TextStyle(color: AppColors.textSecondary, fontSize: 12))),
        CountryFlag(code: storm.code, width: 18),
      ];
    }
    return [CountryFlag(code: storm.code, width: 18)];
  }
}
