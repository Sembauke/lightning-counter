import 'package:flutter/material.dart';

class CountryFlag extends StatelessWidget {
  final String code;
  final double width;

  const CountryFlag({super.key, required this.code, this.width = 20});

  @override
  Widget build(BuildContext context) {
    if (code == 'XO') {
      return SizedBox(width: width, child: Center(child: Text('🌊', style: TextStyle(fontSize: width * 0.7))));
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(2),
      child: Image.network(
        'https://flagcdn.com/w20/${code.toLowerCase()}.png',
        width: width,
        height: width * 0.75,
        fit: BoxFit.cover,
        errorBuilder: (context, error, stackTrace) => SizedBox(width: width, height: width * 0.75),
      ),
    );
  }
}
