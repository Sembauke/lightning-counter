import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

const List<String> kSupportedLocales = ['en', 'nl', 'de', 'fr', 'es'];

/// Persisted app-wide preferences: sound and language.
class SettingsController extends ChangeNotifier {
  static const _kSound = 'sound';
  static const _kLocale = 'locale';

  SharedPreferences? _prefs;

  bool sound = true;
  String locale = 'en';

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _prefs = prefs;
    sound = prefs.getBool(_kSound) ?? true;
    locale = prefs.getString(_kLocale) ?? 'en';
    notifyListeners();
  }

  void toggleSound() {
    sound = !sound;
    _prefs?.setBool(_kSound, sound);
    notifyListeners();
  }

  void setLocale(String value) {
    locale = value;
    _prefs?.setString(_kLocale, value);
    notifyListeners();
  }
}
