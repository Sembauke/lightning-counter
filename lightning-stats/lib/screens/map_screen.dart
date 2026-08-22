import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';

import '../l10n/app_strings.dart';
import '../services/live_strikes_controller.dart';
import '../theme/app_theme.dart';
import '../widgets/lightning_app_bar.dart';
import '../widgets/map/strike_dots_layer.dart';

const _esriUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/// Dims the satellite tiles so strike dots stay legible — matches the web
/// app's `brightness(0.55)` CSS filter on the tile pane.
const List<double> _dimMatrix = [
  0.55, 0, 0, 0, 0, //
  0, 0.55, 0, 0, 0,
  0, 0, 0.55, 0, 0,
  0, 0, 0, 1, 0,
];

class MapScreen extends StatefulWidget {
  const MapScreen({super.key});

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen> {
  final MapController _mapController = MapController();

  @override
  Widget build(BuildContext context) {
    final trackedStorms = context.watch<LiveStrikesController>().trackedStorms;
    final t = AppStrings.of(context);

    return Scaffold(
      appBar: lightningAppBar(context, t.t('nav.strikemap')),
      body: FlutterMap(
        mapController: _mapController,
        options: const MapOptions(
          initialCenter: LatLng(20, 0),
          initialZoom: 2,
          minZoom: 2,
          maxZoom: 16,
        ),
        children: [
          ColorFiltered(
            colorFilter: const ColorFilter.matrix(_dimMatrix),
            child: TileLayer(urlTemplate: _esriUrl, userAgentPackageName: 'com.lightningstats.lightning_stats'),
          ),
          StrikeDotsLayer(mapController: _mapController),
          MarkerLayer(
            markers: [
              for (final s in trackedStorms.where((s) => s.hasPage))
                Marker(
                  point: LatLng(s.lat, s.lon),
                  width: 52,
                  height: 26,
                  child: Container(
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AppColors.accentBorder),
                    ),
                    alignment: Alignment.center,
                    child: Text('#${s.rank} ${s.cc}',
                        style: const TextStyle(color: AppColors.accent, fontSize: 11, fontWeight: FontWeight.bold)),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
