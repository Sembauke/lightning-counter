export default function CountryFlag({ code, name }: { code: string; name: string }) {
  return (
    <img
      src={`https://flagcdn.com/w20/${code.toLowerCase()}.png`}
      alt={name}
      width={20}
      height={15}
      className="cl-flag-img"
      loading="lazy"
    />
  );
}
