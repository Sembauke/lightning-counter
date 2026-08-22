import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../l10n/app_strings.dart';
import '../models/archive.dart';
import '../services/api_client.dart';
import '../theme/app_theme.dart';
import '../utils/country_names.dart';
import '../utils/format.dart';
import '../widgets/country_flag.dart';
import '../widgets/storm_replay_map.dart';

class CountryDetailScreen extends StatefulWidget {
  final String code;
  const CountryDetailScreen({super.key, required this.code});

  @override
  State<CountryDetailScreen> createState() => _CountryDetailScreenState();
}

class _CountryDetailScreenState extends State<CountryDetailScreen> {
  ArchiveRow? _row;
  CountryDetail? _detail;
  String _dateFrom = '';
  String _dateTo = '';
  String _minStrikes = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = context.read<ApiClient>();
    try {
      final archive = await api.fetchArchive();
      final detail = await api.fetchCountry(widget.code);
      if (!mounted) return;
      setState(() {
        _row = archive.where((r) => r.code == widget.code).cast<ArchiveRow?>().firstWhere((_) => true, orElse: () => null);
        _detail = detail;
      });
    } catch (_) {}
  }

  String _stormName(dynamic storm, AppStrings ts) {
    final isXO = widget.code == 'XO';
    final city = storm.city ?? (isXO ? 'Open Ocean' : null);
    final origin = storm.originCity ?? (isXO ? 'Open Ocean' : null);
    if (origin != null && city != null && origin != city) {
      return ts.t('storms.stormFromTo', {'from': origin, 'to': city});
    }
    if (city != null) return ts.t('storms.stormNear', {'city': city});
    return '${storm.lat.toStringAsFixed(2)}, ${storm.lon.toStringAsFixed(2)}';
  }

  @override
  Widget build(BuildContext context) {
    final t = AppStrings.of(context);
    final biggest = _detail?.biggestStorm;
    final history = _detail?.history ?? [];
    final filtered = history.where((h) {
      if (_dateFrom.isNotEmpty && h.date.compareTo(_dateFrom) < 0) return false;
      if (_dateTo.isNotEmpty && h.date.compareTo(_dateTo) > 0) return false;
      final min = int.tryParse(_minStrikes);
      if (min != null && h.count < min) return false;
      return true;
    }).toList();

    return Scaffold(
      appBar: AppBar(
        title: Row(children: [
          CountryFlag(code: widget.code, width: 26),
          const SizedBox(width: 10),
          Text(countryName(widget.code)),
        ]),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
        children: [
          if (_row != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 20),
              child: Wrap(spacing: 24, runSpacing: 8, children: [
                Text('${t.t('stats.todayLabel')} ${fmt(_row!.today)}', style: const TextStyle(color: AppColors.textPrimary, fontSize: 15)),
                Text('${t.t('stats.peakLabel')} ${fmt(_row!.peakCount)} ${t.t('stats.on')} ${_row!.peakDate.isEmpty ? '—' : _row!.peakDate}',
                    style: const TextStyle(color: AppColors.textPrimary, fontSize: 15)),
              ]),
            ),
          if (biggest != null)
            Container(
              padding: const EdgeInsets.all(20),
              margin: const EdgeInsets.only(bottom: 24),
              decoration: BoxDecoration(color: AppColors.surfaceRaised, borderRadius: BorderRadius.circular(14)),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(t.t('stats.biggestStorm'), style: const TextStyle(color: AppColors.accent, fontWeight: FontWeight.bold, fontSize: 15)),
                  const SizedBox(height: 10),
                  Text('⚡ ${_stormName(biggest, t)}', style: const TextStyle(color: AppColors.textPrimary, fontSize: 18, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 8),
                  Text(
                    [
                      t.plural('storms.strikesCount', biggest.totalCount ?? biggest.count),
                      t.t('storms.peakRate', {'rate': fmtRate(biggest.rate)}),
                      biggest.date,
                      if (biggest.startTime != null && biggest.endTime != null)
                        '${fmtClock(biggest.startTime!)} – ${fmtClock(biggest.endTime!)}',
                      if (biggest.traveledKm != null && biggest.traveledKm! >= 5)
                        t.t('storms.traveled', {'km': biggest.traveledKm!.round()}),
                    ].join(' · '),
                    style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                  ),
                  if (biggest.strikes != null && biggest.strikes!.isNotEmpty) ...[
                    const SizedBox(height: 16),
                    StormReplayMap(strikes: biggest.strikes!),
                  ],
                ],
              ),
            ),
          const Text('Filter history', style: TextStyle(color: AppColors.textSecondary, fontSize: 15, fontWeight: FontWeight.bold)),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(child: _dateField(t.t('stats.from'), (v) => setState(() => _dateFrom = v))),
              const SizedBox(width: 12),
              Expanded(child: _dateField(t.t('stats.to'), (v) => setState(() => _dateTo = v))),
            ],
          ),
          const SizedBox(height: 16),
          TextField(
            keyboardType: TextInputType.number,
            style: const TextStyle(fontSize: 15),
            decoration: InputDecoration(labelText: t.t('stats.minStrikes'), labelStyle: const TextStyle(fontSize: 14)),
            onChanged: (v) => setState(() => _minStrikes = v),
          ),
          const SizedBox(height: 28),
          if (filtered.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 20),
              child: Center(child: Text(t.t('stats.noRecords'), style: const TextStyle(color: AppColors.textSecondary, fontSize: 15))),
            )
          else
            Container(
              decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(12)),
              clipBehavior: Clip.antiAlias,
              child: Column(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                    color: AppColors.surfaceRaised,
                    child: Row(
                      children: [
                        Expanded(child: Text(t.t('stats.date'), style: const TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.bold, fontSize: 13))),
                        Text(t.t('stats.strikes'), style: const TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.bold, fontSize: 13)),
                      ],
                    ),
                  ),
                  for (final h in filtered)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                      decoration: const BoxDecoration(border: Border(top: BorderSide(color: AppColors.border))),
                      child: Row(
                        children: [
                          Expanded(child: Text(h.date, style: const TextStyle(fontSize: 15))),
                          Text(fmt(h.count), style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                        ],
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _dateField(String label, void Function(String) onChanged) {
    return TextField(
      readOnly: true,
      style: const TextStyle(fontSize: 15),
      decoration: InputDecoration(labelText: label, labelStyle: const TextStyle(fontSize: 14)),
      onTap: () async {
        final picked = await showDatePicker(
          context: context, firstDate: DateTime(2020), lastDate: DateTime.now(), initialDate: DateTime.now(),
        );
        if (picked != null) onChanged(picked.toIso8601String().substring(0, 10));
      },
    );
  }
}
