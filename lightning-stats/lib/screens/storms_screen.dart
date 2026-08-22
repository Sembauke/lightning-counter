import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../l10n/app_strings.dart';
import '../models/storm.dart';
import '../services/api_client.dart';
import '../theme/app_theme.dart';
import '../utils/country_names.dart';
import '../utils/format.dart';
import '../widgets/lightning_app_bar.dart';
import '../widgets/storm_replay_map.dart';
import '../widgets/storm_row.dart';
import 'storm_detail_screen.dart';

class StormsScreen extends StatefulWidget {
  const StormsScreen({super.key});

  @override
  State<StormsScreen> createState() => _StormsScreenState();
}

class _StormsScreenState extends State<StormsScreen> {
  String _date = todayUtc();
  String _search = '';
  List<StormLogRow> _storms = [];
  bool _loaded = false;
  String? _expandedKey;
  BiggestStorm? _expandedStorm;
  Timer? _pollTimer;

  bool get _isToday => _date == todayUtc();

  @override
  void initState() {
    super.initState();
    _load(first: true);
  }

  Future<void> _load({bool first = false}) async {
    try {
      final rows = await context.read<ApiClient>().fetchStormsForDate(_date);
      if (!mounted) return;
      setState(() {
        _storms = rows;
        _loaded = true;
      });
    } catch (_) {
      if (mounted) setState(() => _loaded = true);
    }
  }

  void _changeDate(String next) {
    _pollTimer?.cancel();
    setState(() {
      _date = next;
      _loaded = false;
      _storms = [];
      _expandedKey = null;
    });
    _load(first: true);
    if (next == todayUtc()) {
      _pollTimer = Timer.periodic(const Duration(seconds: 5), (_) => _load());
    }
  }

  void _shiftDate(int days) {
    final d = DateTime.parse('${_date}T00:00:00Z').add(Duration(days: days));
    final next = d.toIso8601String().substring(0, 10);
    if (next.compareTo(todayUtc()) <= 0) _changeDate(next);
  }

  Future<void> _toggleExpand(String key) async {
    if (_expandedKey == key) {
      setState(() => _expandedKey = null);
      return;
    }
    setState(() {
      _expandedKey = key;
      _expandedStorm = null;
    });
    final storm = await context.read<ApiClient>().fetchStormByKey(key);
    if (mounted && _expandedKey == key) setState(() => _expandedStorm = storm);
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = AppStrings.of(context);
    final now = DateTime.now().millisecondsSinceEpoch;
    bool isLive(StormLogRow s) => _isToday && s.endTime != null && now - s.endTime! < 10 * 60 * 1000;

    final q = _search.trim().toLowerCase();
    final base = q.isEmpty
        ? _storms
        : _storms
            .where((s) =>
                countryName(s.code).toLowerCase().contains(q) ||
                s.code.toLowerCase().contains(q) ||
                (s.city ?? '').toLowerCase().contains(q) ||
                (s.originCity ?? '').toLowerCase().contains(q))
            .toList();
    final live = base.where(isLive).toList()..sort((a, b) => (a.startTime ?? 0).compareTo(b.startTime ?? 0));
    final dead = base.where((s) => !isLive(s)).toList();
    final filtered = [...live, ...dead];

    return Scaffold(
      appBar: lightningAppBar(context, t.t('stormLog.title')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
            child: Row(
              children: [
                IconButton(icon: const Icon(Icons.chevron_left, size: 28), onPressed: () => _shiftDate(-1)),
                Expanded(
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                    onPressed: () async {
                      final picked = await showDatePicker(
                        context: context,
                        firstDate: DateTime(2020),
                        lastDate: DateTime.now(),
                        initialDate: DateTime.parse('${_date}T00:00:00Z'),
                      );
                      if (picked != null) _changeDate(picked.toIso8601String().substring(0, 10));
                    },
                    child: Text(_date, style: const TextStyle(fontSize: 16)),
                  ),
                ),
                IconButton(icon: const Icon(Icons.chevron_right, size: 28), onPressed: _isToday ? null : () => _shiftDate(1)),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: TextField(
              onChanged: (v) => setState(() => _search = v),
              style: const TextStyle(fontSize: 16),
              decoration: InputDecoration(
                hintText: t.t('stormLog.searchPlaceholder'),
                prefixIcon: const Icon(Icons.search, size: 22),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                contentPadding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(t.plural('stormLog.stormsFound', filtered.length), style: const TextStyle(color: AppColors.textSecondary, fontSize: 14)),
            ),
          ),
          const SizedBox(height: 12),
          Expanded(
            child: !_loaded
                ? const Center(child: CircularProgressIndicator())
                : filtered.isEmpty
                    ? Center(child: Text(t.t('stormLog.noStorms'), style: const TextStyle(color: AppColors.textSecondary, fontSize: 15)))
                    : ListView.builder(
                        itemCount: filtered.length,
                        itemBuilder: (context, i) {
                          final s = filtered[i];
                          final live = isLive(s);
                          final expanded = _expandedKey == s.stormKey;
                          return Column(
                            children: [
                              StormRow(
                                storm: s,
                                rank: s.rank,
                                isLive: live,
                                onTap: () {
                                  if (live) {
                                    Navigator.of(context).push(MaterialPageRoute(builder: (_) => StormDetailScreen(stormKey: s.stormKey)));
                                  } else {
                                    _toggleExpand(s.stormKey);
                                  }
                                },
                              ),
                              if (!live && expanded)
                                Padding(
                                  padding: const EdgeInsets.all(20),
                                  child: _expandedStorm?.strikes != null
                                      ? StormReplayMap(strikes: _expandedStorm!.strikes!)
                                      : const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator())),
                                ),
                            ],
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}
