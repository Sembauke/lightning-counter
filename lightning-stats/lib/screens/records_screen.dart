import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../l10n/app_strings.dart';
import '../models/storm.dart';
import '../services/api_client.dart';
import '../theme/app_theme.dart';
import '../utils/format.dart';
import '../widgets/lightning_app_bar.dart';
import '../widgets/storm_row.dart';
import 'storm_detail_screen.dart';

class _Filters {
  int minPeak = 0;
  int minDurationMs = 0;
  int minCountries = 0;
  int minDistanceKm = 0;

  bool get active => minPeak > 0 || minDurationMs > 0 || minCountries > 0 || minDistanceKm > 0;
}

const _durationOptions = [
  (label: 'any', value: 0),
  (label: '30m+', value: 30 * 60000),
  (label: '1h+', value: 60 * 60000),
  (label: '2h+', value: 2 * 60 * 60000),
  (label: '4h+', value: 4 * 60 * 60000),
  (label: '8h+', value: 8 * 60 * 60000),
  (label: '12h+', value: 12 * 60 * 60000),
];
const _countriesOptions = [(label: 'any', value: 0), (label: '2+', value: 2), (label: '3+', value: 3), (label: '4+', value: 4), (label: '5+', value: 5)];
const _distanceOptions = [
  (label: 'any', value: 0),
  (label: '50km+', value: 50),
  (label: '100km+', value: 100),
  (label: '250km+', value: 250),
  (label: '500km+', value: 500),
  (label: '1000km+', value: 1000),
];

class RecordsScreen extends StatefulWidget {
  const RecordsScreen({super.key});

  @override
  State<RecordsScreen> createState() => _RecordsScreenState();
}

class _RecordsScreenState extends State<RecordsScreen> {
  RecordsResponse? _data;
  final _filters = _Filters();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = await context.read<ApiClient>().fetchRecords();
      if (mounted) setState(() => _data = data);
    } catch (_) {}
  }

  void _openStorm(String key) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => StormDetailScreen(stormKey: key)));

  @override
  Widget build(BuildContext context) {
    final t = AppStrings.of(context);
    final data = _data;

    return Scaffold(
      appBar: lightningAppBar(context, t.t('records.title')),
      body: data == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
              children: [
                if (data.storms.isNotEmpty) ...[
                  const Text('Global records', style: TextStyle(color: AppColors.textSecondary, fontSize: 15, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 12,
                    runSpacing: 12,
                    children: data.storms.map((r) {
                      final label = r.category == 'biggest'
                          ? t.t('records.biggest')
                          : r.category == 'longest'
                              ? t.t('records.longest')
                              : t.t('records.farthest');
                      return InkWell(
                        onTap: () => _openStorm(r.stormKey),
                        borderRadius: BorderRadius.circular(12),
                        child: Container(
                          padding: const EdgeInsets.all(16),
                          width: 170,
                          decoration: BoxDecoration(color: AppColors.surfaceRaised, borderRadius: BorderRadius.circular(12)),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(label, style: const TextStyle(color: AppColors.accent, fontSize: 13, fontWeight: FontWeight.bold)),
                              const SizedBox(height: 8),
                              Text(fmt(r.effectiveCount), style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                              const SizedBox(height: 4),
                              Text(r.date, style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                            ],
                          ),
                        ),
                      );
                    }).toList(),
                  ),
                  const SizedBox(height: 32),
                ],
                Text(t.t('records.dailyBest'), style: const TextStyle(color: AppColors.textSecondary, fontSize: 15, fontWeight: FontWeight.bold)),
                const SizedBox(height: 16),
                _filterPanel(),
                const SizedBox(height: 16),
                _dailyList(data.dailyBest, t),
              ],
            ),
    );
  }

  Widget _filterPanel() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: _numberFilterField('Peak ≥', _filters.minPeak, (v) => setState(() => _filters.minPeak = v))),
            const SizedBox(width: 12),
            Expanded(child: _dropdownField('Duration ≥', _durationOptions, _filters.minDurationMs, (v) => setState(() => _filters.minDurationMs = v))),
          ],
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(child: _dropdownField('Countries ≥', _countriesOptions, _filters.minCountries, (v) => setState(() => _filters.minCountries = v))),
            const SizedBox(width: 12),
            Expanded(child: _dropdownField('Distance ≥', _distanceOptions, _filters.minDistanceKm, (v) => setState(() => _filters.minDistanceKm = v))),
          ],
        ),
        if (_filters.active) ...[
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: () => setState(() {
                _filters.minPeak = 0;
                _filters.minDurationMs = 0;
                _filters.minCountries = 0;
                _filters.minDistanceKm = 0;
              }),
              child: const Text('Clear filters', style: TextStyle(fontSize: 14)),
            ),
          ),
        ],
      ],
    );
  }

  Widget _numberFilterField(String label, int value, void Function(int) onChanged) {
    return TextField(
      keyboardType: TextInputType.number,
      style: const TextStyle(fontSize: 15),
      decoration: InputDecoration(labelText: label, labelStyle: const TextStyle(fontSize: 14)),
      onChanged: (v) => onChanged(int.tryParse(v) ?? 0),
    );
  }

  Widget _dropdownField(String label, List<({String label, int value})> options, int value, void Function(int) onChanged) {
    return DropdownButtonFormField<int>(
      initialValue: value,
      style: const TextStyle(fontSize: 15, color: AppColors.textPrimary),
      decoration: InputDecoration(labelText: label, labelStyle: const TextStyle(fontSize: 14)),
      items: options.map((o) => DropdownMenuItem(value: o.value, child: Text(o.label))).toList(),
      onChanged: (v) => onChanged(v ?? 0),
    );
  }

  Widget _dailyList(List<StormLogRow> rows, AppStrings t) {
    final filtered = rows.where((s) {
      if (_filters.minPeak > 0 && s.rate < _filters.minPeak) return false;
      if (_filters.minDurationMs > 0) {
        if (s.startTime == null || s.endTime == null) return false;
        if (s.endTime! - s.startTime! < _filters.minDurationMs) return false;
      }
      if (_filters.minCountries > 0 && (s.countryPath?.length ?? 1) < _filters.minCountries) return false;
      if (_filters.minDistanceKm > 0 && (s.traveledKm ?? 0) < _filters.minDistanceKm) return false;
      return true;
    }).toList();

    if (filtered.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: 24),
        child: Center(
          child: Text(rows.isEmpty ? t.t('records.noData') : 'No storms match the current filters.',
              textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textSecondary, fontSize: 15)),
        ),
      );
    }

    return Container(
      decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(12)),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [for (final s in filtered) StormRow(storm: s, onTap: () => _openStorm(s.stormKey))],
      ),
    );
  }
}
