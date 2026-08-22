import 'package:flutter/material.dart';

import 'live_counter_strip.dart';
import 'settings_sheet.dart';

/// Shared app bar for every tab: title + settings action + the persistent
/// live-counter strip underneath (mirrors Navbar.tsx being present site-wide).
PreferredSizeWidget lightningAppBar(BuildContext context, String title) {
  return AppBar(
    title: Text(title),
    actions: [
      IconButton(
        icon: const Icon(Icons.tune),
        onPressed: () => showSettingsSheet(context),
      ),
    ],
    bottom: const LiveCounterStrip(),
  );
}
