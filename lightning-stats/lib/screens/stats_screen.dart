import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../l10n/app_strings.dart';
import '../models/archive.dart';
import '../services/api_client.dart';
import '../theme/app_theme.dart';
import '../utils/country_names.dart';
import '../utils/format.dart';
import '../widgets/country_flag.dart';
import '../widgets/lightning_app_bar.dart';
import 'country_detail_screen.dart';

enum _SortCol { name, total, today, peak }

class StatsScreen extends StatefulWidget {
  const StatsScreen({super.key});

  @override
  State<StatsScreen> createState() => _StatsScreenState();
}

class _StatsScreenState extends State<StatsScreen> {
  List<ArchiveRow> _rows = [];
  final Map<String, int> _prevToday = {};
  final Map<String, (int amount, int ts)> _deltas = {};
  Timer? _timer;
  String _search = '';
  _SortCol _sortCol = _SortCol.today;
  bool _desc = true;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(milliseconds: 2500), (_) => _load());
  }

  Future<void> _load() async {
    try {
      final rows = await context.read<ApiClient>().fetchArchive();
      final now = DateTime.now().millisecondsSinceEpoch;
      for (final row in rows) {
        final before = _prevToday[row.code];
        if (before != null && row.today > before) {
          _deltas[row.code] = (row.today - before, now);
        }
        _prevToday[row.code] = row.today;
      }
      if (mounted) setState(() => _rows = rows);
    } catch (_) {}
  }

  void _sortBy(_SortCol col) {
    setState(() {
      if (_sortCol == col) {
        _desc = !_desc;
      } else {
        _sortCol = col;
        _desc = col != _SortCol.name;
      }
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = AppStrings.of(context);
    final q = _search.toLowerCase();
    var filtered = q.isEmpty
        ? List.of(_rows)
        : _rows.where((r) => countryName(r.code).toLowerCase().contains(q) || r.code.toLowerCase().contains(q)).toList();

    filtered.sort((a, b) {
      int cmp;
      switch (_sortCol) {
        case _SortCol.name:
          cmp = countryName(a.code).compareTo(countryName(b.code));
          break;
        case _SortCol.total:
          cmp = a.total.compareTo(b.total);
          break;
        case _SortCol.today:
          cmp = a.today.compareTo(b.today);
          break;
        case _SortCol.peak:
          cmp = a.peakCount.compareTo(b.peakCount);
          break;
      }
      return _desc ? -cmp : cmp;
    });

    return Scaffold(
      appBar: lightningAppBar(context, t.t('stats.title')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
            child: TextField(
              onChanged: (v) => setState(() => _search = v),
              style: const TextStyle(fontSize: 16),
              decoration: InputDecoration(
                hintText: t.t('stats.searchPlaceholder'),
                prefixIcon: const Icon(Icons.search, size: 22),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                contentPadding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
              ),
            ),
          ),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: _sortChips(t)),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Text(t.t('stats.countriesFound', {'count': filtered.length}),
                style: const TextStyle(color: AppColors.textSecondary, fontSize: 13)),
          ),
          const SizedBox(height: 8),
          const Divider(height: 1, color: AppColors.border),
          Expanded(
            child: filtered.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: Text(t.t('stats.noData'),
                          textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textSecondary, fontSize: 15)),
                    ),
                  )
                : ListView.separated(
                    itemCount: filtered.length,
                    separatorBuilder: (context, index) => const Divider(height: 1, color: AppColors.border),
                    itemBuilder: (context, i) => _CountryRow(
                      row: filtered[i],
                      delta: _deltas[filtered[i].code],
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute(builder: (_) => CountryDetailScreen(code: filtered[i].code)),
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _sortChips(AppStrings t) {
    Widget chip(String label, _SortCol col) {
      final active = _sortCol == col;
      return ChoiceChip(
        label: Text('$label${active ? (_desc ? ' ↓' : ' ↑') : ''}', style: TextStyle(fontSize: 13, color: active ? AppColors.accent : AppColors.textSecondary)),
        selected: active,
        onSelected: (_) => _sortBy(col),
        selectedColor: AppColors.accent.withValues(alpha: 0.22),
      );
    }

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        chip(t.t('stats.country'), _SortCol.name),
        chip(t.t('stats.total'), _SortCol.total),
        chip(t.t('stats.today'), _SortCol.today),
        chip(t.t('stats.allTimeHigh'), _SortCol.peak),
      ],
    );
  }
}

class _CountryRow extends StatelessWidget {
  final ArchiveRow row;
  final (int amount, int ts)? delta;
  final VoidCallback onTap;

  const _CountryRow({required this.row, required this.delta, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final showDelta = delta != null && DateTime.now().millisecondsSinceEpoch - delta!.$2 < 3000;

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            CountryFlag(code: row.code, width: 30),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(countryName(row.code),
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: 4),
                  Text('Total ${row.total > 0 ? fmt(row.total) : '—'}',
                      style: const TextStyle(color: AppColors.textSecondary, fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
                  Text('Peak ${row.peakCount > 0 ? fmt(row.peakCount) : '—'}',
                      style: const TextStyle(color: AppColors.textSecondary, fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                if (showDelta)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: Text('+${fmt(delta!.$1)}', style: const TextStyle(color: AppColors.accent, fontSize: 12, fontWeight: FontWeight.bold)),
                  ),
                Text(row.today > 0 ? fmt(row.today) : '—',
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: AppColors.textPrimary)),
                const Text('today', style: TextStyle(fontSize: 11, color: AppColors.textSecondary)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
