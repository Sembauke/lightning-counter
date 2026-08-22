import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/archive.dart';
import '../models/storm.dart';
import 'api_config.dart';

class ApiClient {
  final http.Client _client;

  ApiClient({http.Client? client}) : _client = client ?? http.Client();

  Uri _u(String path, [Map<String, String>? query]) =>
      Uri.parse('$kApiBaseUrl$path').replace(queryParameters: query);

  Future<dynamic> _getJson(Uri uri) async {
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw ApiException('${uri.path} returned ${res.statusCode}');
    }
    return jsonDecode(res.body);
  }

  Future<List<ArchiveRow>> fetchArchive() async {
    final json = await _getJson(_u('/api/archive')) as List<dynamic>;
    return json.map((e) => ArchiveRow.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<CountryDetail> fetchCountry(String code) async {
    final json = await _getJson(_u('/api/country/$code')) as Map<String, dynamic>;
    return CountryDetail.fromJson(json);
  }

  Future<RecordsResponse> fetchRecords() async {
    final json = await _getJson(_u('/api/records')) as Map<String, dynamic>;
    return RecordsResponse.fromJson(json);
  }

  Future<List<StormLogRow>> fetchStormsForDate(String date, {String? code}) async {
    final json = await _getJson(
      _u('/api/storms', {'date': date, if (code != null) 'code': code}),
    ) as List<dynamic>;
    return json.map((e) => StormLogRow.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<BiggestStorm?> fetchStormByKey(String key) async {
    final json = await _getJson(_u('/api/storms', {'key': key}));
    if (json == null) return null;
    return BiggestStorm.fromJson(json as Map<String, dynamic>);
  }

  Future<List<LiveStormSummary>> fetchLiveStorms() async {
    final json = await _getJson(_u('/api/storms', {'live': '1'})) as List<dynamic>;
    return json.map((e) => LiveStormSummary.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<StormStrikesResponse> fetchStormStrikes(String key) async {
    final json = await _getJson(_u('/api/storms/${Uri.encodeComponent(key)}/strikes'))
        as Map<String, dynamic>;
    return StormStrikesResponse.fromJson(json);
  }

  void dispose() => _client.close();
}

class ApiException implements Exception {
  final String message;
  ApiException(this.message);
  @override
  String toString() => 'ApiException: $message';
}
