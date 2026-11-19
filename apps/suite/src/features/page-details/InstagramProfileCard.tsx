import type { InstagramProfile } from "./page-details-api.js";

/** The Instagram profile, read-only (suite spec 10, section 7). */
export function InstagramProfileCard({ profile }: { profile: InstagramProfile }): JSX.Element {
  const counts = [
    profile.followers_count !== null ? `${profile.followers_count.toLocaleString("en-GB")} followers` : null,
    profile.media_count !== null ? `${profile.media_count.toLocaleString("en-GB")} posts` : null,
  ].filter(Boolean);
  return (
    <section className="card pd-card">
      <div className="pd-top">
        {profile.profile_picture_url && (
          <img className="pd-avatar" src={profile.profile_picture_url} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
        )}
        <div>
          {profile.username && <div className="pd-name">@{profile.username}</div>}
          {profile.name && <div>{profile.name}</div>}
          {counts.length > 0 && <div className="pd-fine">{counts.join(" · ")}</div>}
        </div>
      </div>
      {profile.biography && <p style={{ whiteSpace: "pre-line" }}>{profile.biography}</p>}
      {profile.website && <p className="pd-fine">{profile.website}</p>}
      <div className="pd-box">
        <strong>Instagram does not let apps change a profile.</strong> To change the name, username, bio, website, picture,
        category or contact buttons, open the Instagram app → your profile → <strong>Edit profile</strong>.
      </div>
      {profile.username && (
        <a className="btn btn--subtle" href={`https://www.instagram.com/${encodeURIComponent(profile.username)}/`} target="_blank" rel="noreferrer">
          Open on Instagram
        </a>
      )}
    </section>
  );
}
