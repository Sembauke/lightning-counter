import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/map_screen.dart';
import 'screens/records_screen.dart';
import 'screens/stats_screen.dart';
import 'screens/storms_screen.dart';
import 'services/settings_controller.dart';

// Bottom-nav labels are kept short (1 word) per Material guidance — the full
// localized strings ("Strike Archive" etc, from nav.* in messages.dart) are
// used as each screen's own AppBar title instead, where there's room to wrap.
const Map<String, List<String>> _navLabels = {
  'en': ['Map', 'Archive', 'Storms', 'Records'],
  'nl': ['Kaart', 'Archief', 'Onweer', 'Records'],
  'de': ['Karte', 'Archiv', 'Gewitter', 'Rekorde'],
  'fr': ['Carte', 'Archive', 'Orages', 'Records'],
  'es': ['Mapa', 'Archivo', 'Tormentas', 'Récords'],
};

class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _index = 0;

  static const _screens = [
    MapScreen(),
    StatsScreen(),
    StormsScreen(),
    RecordsScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    final locale = context.watch<SettingsController>().locale;
    final labels = _navLabels[locale] ?? _navLabels['en']!;
    return Scaffold(
      body: IndexedStack(index: _index, children: _screens),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [
          NavigationDestination(icon: const Icon(Icons.bolt), label: labels[0]),
          NavigationDestination(icon: const Icon(Icons.public), label: labels[1]),
          NavigationDestination(icon: const Icon(Icons.cloud), label: labels[2]),
          NavigationDestination(icon: const Icon(Icons.emoji_events), label: labels[3]),
        ],
      ),
    );
  }
}
