import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:lightning_stats/main.dart';
import 'package:lightning_stats/services/settings_controller.dart';

void main() {
  testWidgets('App shell renders bottom navigation', (WidgetTester tester) async {
    final settings = SettingsController();
    await settings.load();
    await tester.pumpWidget(LightningStatsApp(settings: settings));
    await tester.pump();

    expect(find.byType(NavigationBar), findsOneWidget);
  });
}
