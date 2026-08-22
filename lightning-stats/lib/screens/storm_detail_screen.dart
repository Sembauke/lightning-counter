import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../l10n/app_strings.dart';
import '../models/storm.dart';
import '../models/strike.dart';
import '../services/api_client.dart';
import '../services/api_config.dart';
import '../services/sse_client.dart';
import '../theme/app_theme.dart';
import '../utils/country_names.dart';
import '../utils/format.dart';
import '../utils/storm_naming.dart';
import '../widgets/country_flag.dart';
import '../widgets/storm_replay_map.dart';

const _pollInterval = Duration(seconds: 15);

class StormDetailScreen extends StatefulWidget {
  final String stormKey;
  const StormDetailScreen({super.key, required this.stormKey});

  @override
  State<StormDetailScreen> createState() => _StormDetailScreenState();
}

class _StormDetailScreenState extends State<StormDetailScreen> {
  BiggestStorm? _storm;
  List<GlobalStormRecordLike> _heldRecords = [];
  List<RankedNeighbor> _nearbyRanked = [];
  List<StormStrike> _appendedStrikes = [];
  int _appendedSinceFlush = 0;
  int _latestTs = 0;
  int _stormTotalLive = 0;

  StormStrikesResponse? _liveStats;
  SseClient? _sse;
  StreamSubscription<SseEvent>? _sseSub;
  Timer? _pollTimer;
  Timer? _tickTimer;

  bool get _isLive {
    final endTime = _liveStats?.endTime ?? _storm?.endTime;
    return endTime != null && DateTime.now().millisecondsSinceEpoch - endTime < 10 * 60 * 1000;
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = context.read<ApiClient>();
    try {
      final results = await Future.wait([
        api.fetchStormByKey(widget.stormKey),
        api.fetchStormStrikes(widget.stormKey),
        api.fetchRecords(),
      ]);
      final storm = results[0] as BiggestStorm?;
      final strikesResp = results[1] as StormStrikesResponse;
      final records = results[2] as RecordsResponse;
      if (!mounted || storm == null) return;

      _latestTs = storm.strikes?.fold<int>(0, (m, s) => s.time > m ? s.time : m) ?? 0;

      setState(() {
        _storm = storm;
        _liveStats = strikesResp;
        _nearbyRanked = strikesResp.nearbyRanked;
        _heldRecords = records.storms
            .where((r) => r.stormKey == storm.stormKey)
            .map((r) => GlobalStormRecordLike(category: r.category ?? ''))
            .toList();
      });

      if (_isLive) {
        _startLive();
      }
      _tickTimer = Timer.periodic(const Duration(minutes: 1), (_) => mounted ? setState(() {}) : null);
    } catch (_) {}
  }

  void _startLive() {
    final sse = SseClient(Uri.parse('$kApiBaseUrl/api/storms/${Uri.encodeComponent(widget.stormKey)}/stream'));
    _sse = sse;
    _sseSub = sse.events.listen((e) {
      if (e.event == 'history') {
        try {
          final batch = (jsonDecode(e.data) as List<dynamic>).map((t) => StormStrike.fromJson(t as List<dynamic>)).toList();
          if (batch.isNotEmpty) {
            _latestTs = batch.map((s) => s.time).reduce((a, b) => a > b ? a : b);
            setState(() => _appendedStrikes = batch);
          }
        } catch (_) {}
      } else if (e.event == 'message') {
        try {
          final s = StormStrike.fromJson(jsonDecode(e.data) as List<dynamic>);
          if (s.time > _latestTs) {
            _latestTs = s.time;
            setState(() {
              _appendedStrikes = [..._appendedStrikes, s];
              _appendedSinceFlush++;
            });
          }
        } catch (_) {}
      }
    });
    sse.connect();

    _pollTimer = Timer.periodic(_pollInterval, (_) => _poll());
    _poll();
  }

  Future<void> _poll() async {
    try {
      final data = await context.read<ApiClient>().fetchStormStrikes(widget.stormKey);
      if (!mounted) return;
      final dbTotal = data.totalCount ?? data.count;
      final fresh = data.strikes.where((s) => s.time > _latestTs).toList();
      for (final s in fresh) {
        if (s.time > _latestTs) _latestTs = s.time;
      }
      setState(() {
        _liveStats = data;
        _nearbyRanked = data.nearbyRanked;
        _appendedSinceFlush = (_stormTotalLive - dbTotal).clamp(0, 1 << 30);
        if (fresh.isNotEmpty) _appendedStrikes = [..._appendedStrikes, ...fresh];
      });
      if (!_isLive) {
        _sseSub?.cancel();
        _sse?.dispose();
        _pollTimer?.cancel();
      }
    } catch (_) {}
  }

  @override
  void dispose() {
    _sseSub?.cancel();
    _sse?.dispose();
    _pollTimer?.cancel();
    _tickTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final storm = _storm;
    final t = AppStrings.of(context);
    if (storm == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final live = _liveStats;
    final baseTotal = live?.totalCount ?? live?.count ?? storm.totalCount ?? storm.count;
    _stormTotalLive = baseTotal + _appendedSinceFlush;
    final rate = live?.rate ?? storm.rate;
    final startTime = live?.startTime ?? storm.startTime;
    final endTime = live?.endTime ?? storm.endTime;
    final traveledKm = live?.traveledKm ?? storm.traveledKm;
    final city = live?.city ?? storm.city;
    final originCity = live?.originCity ?? storm.originCity;
    final duration = startTime != null && endTime != null ? endTime - startTime : null;

    final name = stormLabel(t, city: city, originCity: originCity, code: storm.code, lat: storm.lat, lon: storm.lon);

    final allStrikes = <StormStrike>[...(storm.strikes ?? const <StormStrike>[]), ..._appendedStrikes];
    final timeline = allStrikes.length >= 2 ? _computeTimeline(allStrikes) : null;

    final localRanked = List<RankedNeighbor>.from(_nearbyRanked.map(
      (n) => n.stormKey == storm.stormKey ? n.copyWith(totalCount: _stormTotalLive) : n,
    ))
      ..sort((a, b) => b.totalCount.compareTo(a.totalCount));
    final baseRank = _nearbyRanked.isNotEmpty ? _nearbyRanked.first.rank : 1;
    for (var i = 0; i < localRanked.length; i++) {
      localRanked[i] = localRanked[i].copyWith(rank: baseRank + i);
    }

    return Scaffold(
      appBar: AppBar(title: Text(name, overflow: TextOverflow.ellipsis)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
        children: [
          Row(
            children: [
              if (storm.countryPath != null && storm.countryPath!.length > 1)
                ...storm.countryPath!.expand((cc) => [CountryFlag(code: cc, width: 24), const SizedBox(width: 6), Text(countryName(cc), style: const TextStyle(fontSize: 14)), const SizedBox(width: 12)])
              else ...[
                CountryFlag(code: storm.code, width: 24),
                const SizedBox(width: 8),
                Text(countryName(storm.code), style: const TextStyle(fontSize: 14)),
              ],
            ],
          ),
          const SizedBox(height: 14),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final r in _heldRecords)
              Chip(
                label: Text(r.category == 'biggest' ? 'Record — Biggest' : r.category == 'longest' ? 'Record — Longest' : 'Record — Farthest',
                    style: const TextStyle(fontSize: 12)),
                backgroundColor: AppColors.accent.withValues(alpha: 0.15),
              ),
          ]),
          const SizedBox(height: 20),
          _kpiGrid(_stormTotalLive, rate, duration, _isLive, startTime, traveledKm),
          if (timeline != null) ...[
            const SizedBox(height: 32),
            const Text('Strike intensity (last 60 min)', style: TextStyle(color: AppColors.textSecondary, fontSize: 15, fontWeight: FontWeight.bold)),
            const SizedBox(height: 14),
            _TimelineChart(minuteCounts: timeline),
          ],
          if (localRanked.length > 1) ...[
            const SizedBox(height: 32),
            const Text('All-time leaderboard ranking', style: TextStyle(color: AppColors.textSecondary, fontSize: 15, fontWeight: FontWeight.bold)),
            const SizedBox(height: 12),
            Container(
              decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(12)),
              clipBehavior: Clip.antiAlias,
              child: Column(
                children: [
                  for (final n in localRanked)
                    _leaderboardRow(context, n, isCurrent: n.stormKey == storm.stormKey, name: name, t: t),
                ],
              ),
            ),
          ],
          const SizedBox(height: 32),
          Text(_isLive ? 'Live map' : 'Strike replay', style: const TextStyle(color: AppColors.textSecondary, fontSize: 15, fontWeight: FontWeight.bold)),
          const SizedBox(height: 14),
          StormReplayMap(
            strikes: storm.strikes ?? [],
            appendedStrikes: _appendedStrikes.isNotEmpty ? _appendedStrikes : null,
            isLive: _isLive,
          ),
        ],
      ),
    );
  }

  Widget _leaderboardRow(BuildContext context, RankedNeighbor n, {required bool isCurrent, required String name, required AppStrings t}) {
    final label = isCurrent ? name : stormLabel(t, city: n.city, originCity: n.originCity, code: n.code, lat: n.lat, lon: n.lon);
    return InkWell(
      onTap: isCurrent ? null : () => Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => StormDetailScreen(stormKey: n.stormKey))),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
        decoration: BoxDecoration(
          color: isCurrent ? AppColors.accent.withValues(alpha: 0.1) : null,
          border: const Border(top: BorderSide(color: AppColors.border)),
        ),
        child: Row(children: [
          SizedBox(width: 40, child: Text('#${n.rank}', style: const TextStyle(fontSize: 14, color: AppColors.textSecondary))),
          Expanded(child: Text(label, style: TextStyle(fontSize: 15, fontWeight: isCurrent ? FontWeight.bold : FontWeight.normal), overflow: TextOverflow.ellipsis)),
          Text(fmt(n.totalCount), style: const TextStyle(fontSize: 15, color: AppColors.accent, fontWeight: FontWeight.w600)),
        ]),
      ),
    );
  }

  Widget _kpiGrid(int total, double rate, int? duration, bool isLive, int? startTime, double? traveledKm) {
    Widget kpi(String value, String label) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(value, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: AppColors.accent), maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 4),
            Text(label, style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
          ],
        );
    final durationText = duration != null
        ? fmtDuration(duration)
        : (isLive && startTime != null ? fmtDuration(DateTime.now().millisecondsSinceEpoch - startTime) : '—');
    final items = [
      kpi(fmt(total), 'Total strikes'),
      kpi('${fmtRate(rate)}/min', 'Peak rate'),
      if (duration != null || isLive) kpi(durationText, 'Duration'),
      if (traveledKm != null && traveledKm >= 1) kpi('${traveledKm.round()}km', 'Distance'),
    ];
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      crossAxisSpacing: 16,
      mainAxisSpacing: 16,
      childAspectRatio: 2.6,
      children: items,
    );
  }

  List<_MinuteBucket> _computeTimeline(List<StormStrike> strikes) {
    final sorted = List.of(strikes)..sort((a, b) => a.time.compareTo(b.time));
    final firstMs = sorted.first.time;
    final buckets = <int, int>{};
    for (final s in sorted) {
      final min = ((s.time - firstMs) / 60000).floor();
      buckets[min] = (buckets[min] ?? 0) + 1;
    }
    final maxMin = buckets.keys.reduce((a, b) => a > b ? a : b);
    final all = [for (var m = 0; m <= maxMin; m++) _MinuteBucket(m, buckets[m] ?? 0)];
    return all.length > 60 ? all.sublist(all.length - 60) : all;
  }
}

class GlobalStormRecordLike {
  final String category;
  GlobalStormRecordLike({required this.category});
}

class _MinuteBucket {
  final int minute;
  final int count;
  _MinuteBucket(this.minute, this.count);
}

class _TimelineChart extends StatelessWidget {
  final List<_MinuteBucket> minuteCounts;
  const _TimelineChart({required this.minuteCounts});

  @override
  Widget build(BuildContext context) {
    final maxCount = minuteCounts.map((b) => b.count).fold(1, (a, b) => a > b ? a : b);
    final peak = minuteCounts.map((b) => b.count).reduce((a, b) => a > b ? a : b);
    return SizedBox(
      height: 90,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (final b in minuteCounts)
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 0.5),
                child: Container(
                  height: 90 * (b.count / maxCount).clamp(0.02, 1.0),
                  color: b.count == peak ? const Color(0xFFFFE566) : Color.fromRGBO(255, 210, 50, 0.25 + 0.75 * (b.count / maxCount)),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
