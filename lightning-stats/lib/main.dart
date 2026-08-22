import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';

import 'app_shell.dart';
import 'services/api_client.dart';
import 'services/live_counter_controller.dart';
import 'services/live_strikes_controller.dart';
import 'services/settings_controller.dart';
import 'theme/app_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final settings = SettingsController();
  await settings.load();
  runApp(LightningStatsApp(settings: settings));
}

class LightningStatsApp extends StatelessWidget {
  final SettingsController settings;
  const LightningStatsApp({super.key, required this.settings});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: settings),
        Provider(create: (_) => ApiClient(), dispose: (_, c) => c.dispose()),
        ChangeNotifierProvider(create: (_) => LiveStrikesController()),
        ChangeNotifierProvider(create: (_) => LiveCounterController()),
      ],
      child: Consumer<SettingsController>(
        builder: (context, s, _) => MaterialApp(
          title: 'Lightning Stats',
          debugShowCheckedModeBanner: false,
          theme: buildAppTheme(),
          locale: Locale(s.locale),
          supportedLocales: kSupportedLocales.map(Locale.new),
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: const AppShell(),
        ),
      ),
    );
  }
}
